"""手写 .docx 生成器（不依赖 python-docx）。

docx = zip 包 + OOXML。这里只实现需要的最小集合：
段落、粗体、字号、标题、图片、超链接（省略）。

用法：python tools/make-docx.py
输出：docs/图文教程.docx、docs/创作说明.docx
"""
import os
import struct
import zipfile
from xml.sax.saxutils import escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EMU_PER_CM = 360000


def para_xml(text, *, size=22, bold=False, color=None, align=None, space_after=120):
    """size 单位是半磅（22 = 11pt）。"""
    jc = f'<w:jc w:val="{align}"/>' if align else ''
    rpr = [f'<w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei" w:hAnsi="Microsoft YaHei"/>']
    if bold:
        rpr.append('<w:b/>')
    rpr.append(f'<w:sz w:val="{size}"/><w:szCs w:val="{size}"/>')
    if color:
        rpr.append(f'<w:color w:val="{color}"/>')
    body = escape(text).replace('\n', '</w:t><w:br/><w:t xml:space="preserve">')
    return (
        '<w:p><w:pPr>'
        f'<w:spacing w:before="60" w:after="{space_after}" w:line="320" w:lineRule="auto"/>{jc}'
        '</w:pPr>'
        f'<w:r><w:rPr>{"".join(rpr)}</w:rPr><w:t xml:space="preserve">{body}</w:t></w:r>'
        '</w:p>'
    )


def image_xml(rid, pid, width_cm, height_cm):
    cx = int(width_cm * EMU_PER_CM)
    cy = int(height_cm * EMU_PER_CM)
    return f'''<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="200"/></w:pPr>
<w:r><w:drawing>
<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">
<wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="{pid}" name="Picture {pid}"/>
<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>
<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:nvPicPr><pic:cNvPr id="{pid}" name="image{pid}.png"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>
<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'''


def build(path, blocks, images):
    """blocks: [(kind, payload)]；images: [(绝对路径, 宽cm, 高cm)]"""
    parts = []
    pic_id = 100
    for kind, payload in blocks:
        if kind == 'title':
            parts.append(para_xml(payload, size=40, bold=True, align='center', space_after=240))
        elif kind == 'sub':
            parts.append(para_xml(payload, size=22, color='6B7C93', align='center', space_after=320))
        elif kind == 'h':
            parts.append(para_xml(payload, size=30, bold=True, color='1F3A5F', space_after=160))
        elif kind == 'p':
            parts.append(para_xml(payload))
        elif kind == 'quote':
            parts.append(para_xml(payload, size=20, color='7A8AA0'))
        elif kind == 'img':
            idx = payload
            w, h = images[idx][1], images[idx][2]
            rid = f'rIdImg{idx + 1}'
            parts.append(image_xml(rid, pic_id, w, h))
            pic_id += 1
    body = ''.join(parts)

    doc = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="0" w:footer="0" w:gutter="0"/>
</w:sectPr></w:body></w:document>'''

    rels = ['<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>']
    for i, (abs_path, w, h) in enumerate(images):
        rels.append(
            f'<Relationship Id="rIdImg{i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image{i + 1}.png"/>'
        )
    doc_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + ''.join(rels)
        + '</Relationships>'
    )

    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="png" ContentType="image/png"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        '</Types>'
    )

    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        '</Relationships>'
    )

    styles = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:docDefaults><w:rPrDefault><w:rPr>'
        '<w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/>'
        '<w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>'
        '</w:styles>'
    )

    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', content_types)
        z.writestr('_rels/.rels', root_rels)
        z.writestr('word/document.xml', doc)
        z.writestr('word/_rels/document.xml.rels', doc_rels)
        z.writestr('word/styles.xml', styles)
        for i, (abs_path, w, h) in enumerate(images):
            z.write(abs_path, f'word/media/image{i + 1}.png')
    print(f'  ✓ {os.path.relpath(path, ROOT)}  ({os.path.getsize(path) // 1024} KB)')


SHOTS = os.path.join(ROOT, 'docs', 'screenshots')
TUTORIAL_IMAGES = [
    (os.path.join(SHOTS, 'game-0-idle.png'), 15.0, 8.44),
    (os.path.join(SHOTS, 'stage-gift-t4.png'), 15.0, 8.44),
    (os.path.join(SHOTS, 'game-1-start.png'), 15.0, 8.44),
    (os.path.join(SHOTS, 'game-2-pick.png'), 15.0, 8.44),
    (os.path.join(SHOTS, 'game-4-reveal.png'), 15.0, 8.44),
]

TUTORIAL = [
    ('title', '我给虚拟主播做了个"会心疼钱"的大脑'),
    ('sub', '不用真人出镜，一只 AI 鲸鱼娘替你直播：读弹幕、按打赏档位做反应、还能和观众玩猜词'),
    ('p', '全套跑在你自己电脑上，OBS 叠一层浏览器源就能上播。'),
    ('h', '一、它长这样'),
    ('img', 0),
    ('p', '一只蓝头发的鲸鱼娘坐在桌前，左下角常驻一张卡片，告诉新来的观众"送小心心就能玩"。'),
    ('p', '有人送礼物，她会按金额换反应——小心心只是点头，跑车就喷水撒花，嘉年华直接烟花齐放：'),
    ('img', 1),
    ('p', '送够门槛还能触发一局猜词游戏：答案在观众手里，她来猜。'),
    ('img', 2),
    ('h', '二、为什么做这个'),
    ('p', '我看了很多虚拟主播，形象一个比一个精致，但"反应"是死的：'),
    ('p', '· 弹幕照念，不管说什么都是同一句"谢谢宝宝"\n· 礼物只会说谢谢，送一块和送一万没有区别\n· 观众刷完就走，因为没有留下来的理由'),
    ('p', '所以我把重点放在两件事上。'),
    ('p', '第一，打赏要分级。让人一眼看出"她注意到我花了多少钱"——这是直播最朴素的驱动力。'),
    ('p', '第二，不花钱的观众也得有事干。猜词游戏就是给他们的：不用送礼，发个数字就能参与。'),
    ('h', '三、怎么跑起来'),
    ('p', '第一步，环境。'),
    ('quote', 'git clone https://github.com/ejekess/ds-live--streaming.git\ncd ds-live--streaming\nnpm install\nnode src/index.mjs'),
    ('p', '看到这两行就成了：'),
    ('quote', '舞台（OBS 浏览器源）： http://127.0.0.1:8787/avatar\n管控台：               http://127.0.0.1:8787/admin/'),
    ('p', '第二步，接进 OBS。来源 → + → 浏览器，URL 填 http://127.0.0.1:8787/avatar?bg=gradient，宽高 1920 × 1080。背景透明，叠在你自己的画面上就行。'),
    ('p', '第三步，接真实弹幕。默认用的是 mock 剧本（假弹幕），方便调试。要接真直播间：'),
    ('quote', 'node tools\\live.mjs 你的房间号'),
    ('p', '重启服务，日志出现"已挂上推送信道"就通了。注意：抓取会在浏览器里打开你的直播间页面，需要扫码登录一次（匿名看不了弹幕），登录态会存下来。'),
    ('p', '第四步，玩一局。管控台「猜词小游戏」→ 开一局。观众在直播间发数字就行：选题阶段发 1/2/3 挑问题，回答阶段发 1-4 选答案，0 表示不确定。'),
    ('img', 3),
    ('p', '五轮之后揭晓答案。'),
    ('img', 4),
    ('h', '四、设计上最花时间的四个决定'),
    ('p', '这部分是我觉得真正值得说的。'),
    ('p', '① 为什么用"浏览器旁听"而不是自己连抖音。'),
    ('p', '网上现成的方案都是自己算签名去连抖音的 WebSocket。问题是那个签名算法平台一改就全废，你得一直跟着修。我反过来做——用本机浏览器打开直播间，让它自己完成握手，我们只旁听它收到的数据帧。浏览器替我们处理了签名、心跳、登录态，我们只管解 protobuf。代价是要开一个浏览器窗口，换来的是不怕平台改签名。'),
    ('p', '② 为什么答案不能进模型。'),
    ('p', '反向猜词的关键是"她不知道答案"。这件事我用数据结构保证，不是靠提示词：答案存在游戏对象里，快照在揭晓前是 null，台词里根本没有这个词。给舞台画面用的字段刻意叫 displayWord 不叫 word，防止有人顺手把它拼进 prompt。'),
    ('p', '同理，模型能做决策，但没有结束游戏的权力：它只输出"我猜是 XX"，对错由程序比对。'),
    ('p', '③ 为什么语音要排队。'),
    ('p', '第一版是"合成完就播，下一条来了直接顶掉"。结果观众看到的是：字已经跳到下一句，声音还卡在上半句。改成串行队伍——一次只说一句，说完才说下一句，气泡和音频同时出现。代价是高峰期延迟几秒，但"晚说一句"比"说半句被掐"好得多。'),
    ('p', '④ 为什么给游戏预留额度。'),
    ('p', '大模型有每日调用上限。测试时发现：直播间弹幕一多，闲聊把额度吃光，猜词决策一次都排不上——游戏照常跑，只是从"她在思考"退化成"她一直问到底"，还不报错。修法是给游戏预留 20%：闲聊用到 80% 就停。'),
    ('h', '五、踩过的坑'),
    ('p', '全都是"不报错但静默失效"的：'),
    ('p', '· 抓到帧却解不出事件 —— 抖音把 gzip 报文标成 pb，我信了字段名没解压\n· 开场动画从来没出现过 —— 分发钩子时漏转发一个，事件发了没人接\n· 页面全超时但接口正常 —— 父进程退出后日志管道写满，事件循环被堵死\n· 改了代码页面不更新 —— OBS 浏览器源缓存页面，不会自动重载'),
    ('p', '共同点是：光看代码看不出来，必须真跑一遍。'),
    ('h', '六、最后'),
    ('p', '这套东西现在能做的：Live2D 形象 + 分级打赏演出 + 实时弹幕 + 语音 + 猜词游戏 + 数据统计，全套本地跑，不依赖任何云服务。'),
    ('p', '代码和文档都在仓库里，自检有 366 项，改完跑一遍就知道有没有弄坏。'),
]

STATEMENT = [
    ('title', '创作说明'),
    ('h', '为什么选这个'),
    ('p', '虚拟主播形象都精致，但"反应"是死的——礼物只会说谢谢，送一块和送一万没区别。让人愿意刷礼物的，是"她知道你花了多少钱"。所以核心做打赏分级，五档换五套演出；猜词游戏给不花钱的观众一个开口的理由。'),
    ('h', '需求分析'),
    ('p', '四条硬约束。①不能卡：演出、语音、游戏三套时序会打架，拆成纯状态机加定时器；②不能烧 token：限长、双上限、超时，还要给游戏预留额度，否则闲聊会把猜词调用吃光；③不能碰版权：点歌做完直接停用；④不能被注入：模型只拿纯文本、无工具，答案和流程都在宿主代码里。'),
    ('h', 'AI 工具'),
    ('p', 'DeepSeek Harness 结对，我定架构和取舍（"答案不能进 prompt""模型不能有结束权"），它写实现和自检。'),
    ('h', '踩坑'),
    ('p', '都是不报错但静默失效——抖音把 gzip 标成 pb，我信字段名解出 0 条；钩子漏转发，开场动画从没显示过。只有真跑才暴露。'),
    ('h', '发布'),
    ('p', '《我给虚拟主播做了个"会心疼钱"的大脑》，小红书首发。'),
]

if __name__ == '__main__':
    print('生成 Word：')
    build(os.path.join(ROOT, 'docs', '图文教程.docx'), TUTORIAL, TUTORIAL_IMAGES)
    build(os.path.join(ROOT, 'docs', '创作说明.docx'), STATEMENT, [])
