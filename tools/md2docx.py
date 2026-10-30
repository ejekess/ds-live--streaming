"""把 docs 里的 Markdown 转成 .docx（不依赖 python-docx）。

docx = zip + OOXML。这里只实现文档需要的那部分：
标题、二级/三级标题、正文、引用、代码块、列表、表格、图片。

用法：
    python tools/md2docx.py                 # 转换 图文教程 + 创作说明
    python tools/md2docx.py docs/xxx.md     # 转换指定文件

约定：Markdown 是唯一真相，改了 md 重跑这个脚本即可，不用两边维护。
"""
import os
import re
import struct
import sys
import zipfile
from xml.sax.saxutils import escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EMU_PER_CM = 360000
MAX_IMG_CM = 15.0


def _run(text, *, size=22, bold=False, color=None, mono=False):
    font = 'Consolas' if mono else 'Microsoft YaHei'
    rpr = ['<w:rFonts w:ascii="%s" w:eastAsia="%s" w:hAnsi="%s"/>' % (font, font, font)]
    if bold:
        rpr.append('<w:b/>')
    rpr.append('<w:sz w:val="%d"/><w:szCs w:val="%d"/>' % (size, size))
    if color:
        rpr.append('<w:color w:val="%s"/>' % color)
    body = escape(text).replace('\n', '</w:t><w:br/><w:t xml:space="preserve">')
    return '<w:r><w:rPr>%s</w:rPr><w:t xml:space="preserve">%s</w:t></w:r>' % (''.join(rpr), body)


def para(runs, *, align=None, before=60, after=140, line=320, shade=None):
    jc = '<w:jc w:val="%s"/>' % align if align else ''
    shd = '<w:shd w:val="clear" w:fill="%s"/>' % shade if shade else ''
    return ('<w:p><w:pPr><w:spacing w:before="%d" w:after="%d" w:line="%d" w:lineRule="auto"/>%s%s</w:pPr>%s</w:p>'
            % (before, after, line, jc, shd, runs))


def image_xml(rid, pid, width_cm, height_cm):
    cx = int(width_cm * EMU_PER_CM)
    cy = int(height_cm * EMU_PER_CM)
    return '''<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="160" w:after="240"/></w:pPr>
<w:r><w:drawing>
<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">
<wp:extent cx="%d" cy="%d"/><wp:docPr id="%d" name="Picture %d"/>
<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>
<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:nvPicPr><pic:cNvPr id="%d" name="image%d.png"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="%s"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="%d" cy="%d"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>''' % (
        cx, cy, pid, pid, pid, pid, rid, cx, cy)


def png_size(path):
    try:
        with open(path, 'rb') as f:
            head = f.read(24)
        if head[:8] == b'\x89PNG\r\n\x1a\n':
            return struct.unpack('>II', head[16:24])
    except Exception:
        pass
    return None


INLINE = re.compile(r'\*\*(.+?)\*\*|`([^`]+)`')


def inline_runs(text, *, size=22, color=None):
    out = []
    pos = 0
    for m in INLINE.finditer(text):
        if m.start() > pos:
            out.append(_run(text[pos:m.start()], size=size, color=color))
        if m.group(1) is not None:
            out.append(_run(m.group(1), size=size, bold=True, color=color))
        else:
            out.append(_run(m.group(2), size=size, mono=True, color='2B5C96'))
        pos = m.end()
    if pos < len(text):
        out.append(_run(text[pos:], size=size, color=color))
    return ''.join(out) if out else _run(text, size=size, color=color)


def convert(md_path, docx_path):
    md_dir = os.path.dirname(md_path)
    lines = open(md_path, encoding='utf-8').read().split('\n')

    blocks = []
    images = []
    i = 0
    in_code = False
    code_buf = []
    table_buf = []

    def flush_table():
        nonlocal table_buf
        if not table_buf:
            return
        rows = [r for r in table_buf if not re.match(r'^\|[\s:\-|]+\|$', r)]
        for idx, row in enumerate(rows):
            cells = [c.strip() for c in row.strip().strip('|').split('|')]
            text = '  |  '.join(cells)
            blocks.append(para(inline_runs(text, size=18), after=50,
                               shade='F2F6FB' if idx == 0 else None))
        table_buf = []

    while i < len(lines):
        raw = lines[i]
        line = raw.rstrip()

        if line.startswith('```'):
            if in_code:
                blocks.append(para(_run('\n'.join(code_buf), size=18, mono=True),
                                   shade='F4F6F9', after=160))
                code_buf = []
                in_code = False
            else:
                flush_table()
                in_code = True
            i += 1
            continue
        if in_code:
            code_buf.append(raw)
            i += 1
            continue

        if line.startswith('|'):
            table_buf.append(line)
            i += 1
            continue
        flush_table()

        if line.startswith('# '):
            blocks.append(para(_run(line[2:].strip(), size=40, bold=True), align='center', after=260))
        elif line.startswith('## '):
            blocks.append(para(_run(line[3:].strip(), size=30, bold=True, color='1F3A5F'), before=260, after=160))
        elif line.startswith('### '):
            blocks.append(para(_run(line[4:].strip(), size=25, bold=True, color='2B5C96'), before=200, after=120))
        elif line.strip().startswith('!['):
            m = re.match(r'!\[(.*?)\]\((.+?)\)', line.strip())
            if m:
                rel = m.group(2)
                abs_img = rel if os.path.isabs(rel) else os.path.normpath(os.path.join(md_dir, rel))
                if os.path.exists(abs_img):
                    size = png_size(abs_img)
                    if size:
                        w, h = size
                        width_cm = MAX_IMG_CM
                        height_cm = MAX_IMG_CM * h / w
                    else:
                        width_cm, height_cm = MAX_IMG_CM, MAX_IMG_CM * 0.56
                    images.append((abs_img, width_cm, height_cm))
                    blocks.append(('img', len(images) - 1))
                else:
                    blocks.append(para(_run('[缺图] ' + rel, size=18, color='B00020')))
        elif line.startswith('> '):
            blocks.append(para(_run(line[2:].strip(), size=20, color='5B6B80'), shade='F7F9FC', after=120))
        elif line.strip() in ('---', '***'):
            blocks.append(para(_run(' ', size=10), after=60))
        elif re.match(r'^\s*[-*] ', line):
            text = re.sub(r'^\s*[-*] ', '', line)
            blocks.append(para(_run('· ', size=22) + inline_runs(text), after=80))
        elif re.match(r'^\s*\d+\. ', line):
            blocks.append(para(inline_runs(line.strip()), after=80))
        elif not line.strip():
            pass
        else:
            blocks.append(para(inline_runs(line.strip())))
        i += 1

    flush_table()
    if code_buf:
        blocks.append(para(_run('\n'.join(code_buf), size=18, mono=True), shade='F4F6F9'))

    body = []
    pic_id = 100
    for item in blocks:
        if isinstance(item, tuple) and item and item[0] == 'img':
            payload = item[1]
            w, h = images[payload][1], images[payload][2]
            body.append(image_xml('rIdImg%d' % (payload + 1), pic_id, w, h))
            pic_id += 1
        else:
            body.append(item)

    doc = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>%s<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="0" w:footer="0" w:gutter="0"/>
</w:sectPr></w:body></w:document>''' % ''.join(body)

    rels = ['<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>']
    for idx in range(len(images)):
        rels.append('<Relationship Id="rIdImg%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image%d.png"/>' % (idx + 1, idx + 1))
    doc_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                + ''.join(rels) + '</Relationships>')
    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                     '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Default Extension="xml" ContentType="application/xml"/>'
                     '<Default Extension="png" ContentType="image/png"/>'
                     '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                     '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
                     '</Types>')
    root_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                 '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
                 '</Relationships>')
    styles = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
              '<w:docDefaults><w:rPrDefault><w:rPr>'
              '<w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/>'
              '<w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>')

    with zipfile.ZipFile(docx_path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', content_types)
        z.writestr('_rels/.rels', root_rels)
        z.writestr('word/document.xml', doc)
        z.writestr('word/_rels/document.xml.rels', doc_rels)
        z.writestr('word/styles.xml', styles)
        for idx, (abs_img, w, h) in enumerate(images):
            z.write(abs_img, 'word/media/image%d.png' % (idx + 1))

    print('  OK  %-24s %5d KB   段落 %d   图 %d'
          % (os.path.basename(docx_path), os.path.getsize(docx_path) // 1024,
             sum(1 for b in blocks if not (isinstance(b, tuple) and b and b[0] == 'img')), len(images)))


if __name__ == '__main__':
    targets = sys.argv[1:]
    if not targets:
        targets = [os.path.join(ROOT, 'docs', '图文教程.md'),
                   os.path.join(ROOT, 'docs', '创作说明.md')]
    print('Markdown -> Word：')
    for md in targets:
        if not os.path.exists(md):
            print('  跳过（不存在）', md)
            continue
        convert(md, os.path.splitext(md)[0] + '.docx')
