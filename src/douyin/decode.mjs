/**
 * 把一帧推送字节流翻译成本项目的统一事件。
 *
 * 链路：二进制帧 → PushFrame → (payloadType === 'msg') → gunzip → Response
 *       → messagesList[] → 按 method 解具体消息 → 归一化。
 *
 * 这里刻意保持纯函数：输入 buffer，输出事件数组 + 诊断信息。
 * 抓取层（CDP / 外部进程）只管把字节丢进来，能单测、能离线回放。
 */
import { gunzipSync } from 'node:zlib';
import { decodePushFrame, decodeResponse, decodePayload, knowsMethod } from './proto.mjs';
import { make } from '../events.mjs';

/** protobufjs 的 64 位整数可能是 number / Long / string / bigint，统一收敛。 */
function num(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') return Number(v) || 0;
  if (typeof v.toNumber === 'function') return v.toNumber();
  return Number(v) || 0;
}

function str(v) {
  return v == null ? '' : String(v);
}

/**
 * User → Viewer。身份优先用 secUid（换昵称也不变），
 * 等级只是展示用，粉丝团等级优先于消费等级。
 */
function toViewer(u) {
  if (!u) return undefined;
  const fans = u.fansClub && u.fansClub.data;
  const fanLevel = num(fans && fans.level);
  return {
    id: str(u.secUid) || str(u.idStr) || str(num(u.id)) || '',
    name: str(u.nickName) || '观众',
    level: fanLevel || num(u.payGrade && u.payGrade.level),
    isFan: fanLevel > 0 || num(fans && fans.userFansClubStatus) === 1,
    isAdmin: false,
  };
}

/**
 * @param {Buffer|Uint8Array} frame
 * @returns {{events: import('../events.mjs').LiveEvent[], meta: {payloadType:string, methods:string[], unknown:string[]}}}
 */
export function decodeFrame(frame) {
  const meta = { payloadType: '', encoding: '', methods: [], unknown: [] };
  const events = [];

  let push;
  try {
    push = decodePushFrame(frame);
  } catch {
    return { events, meta: { ...meta, payloadType: 'undecodable' } };
  }

  const payloadType = str(push.payloadType);
  meta.payloadType = payloadType;

  // 'ack'（客户端确认）、'hb'（心跳）等不含业务消息
  if (payloadType !== 'msg') return { events, meta };

  let body = Buffer.from(push.payload || []);
  // ⚠️ 不要相信 payloadEncoding：实测抖音现在把它标成 "pb"，内容却仍是 gzip。
  // 靠魔数判断（1f 8b）才是可靠的；标 gzip 但没魔数就按裸 protobuf 处理。
  if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) {
    try {
      body = gunzipSync(body);
      meta.encoding = 'gzip';
    } catch {
      return { events, meta: { ...meta, payloadType: 'msg/gzip-error' } };
    }
  } else {
    meta.encoding = 'raw';
  }

  let resp;
  try {
    resp = decodeResponse(body);
  } catch {
    return { events, meta: { ...meta, payloadType: 'msg/decode-error' } };
  }

  for (const msg of resp.messagesList || []) {
    const method = str(msg.method);
    meta.methods.push(method);
    if (!knowsMethod(method)) {
      if (!meta.unknown.includes(method)) meta.unknown.push(method);
      continue;
    }
    const body = decodePayload(method, Buffer.from(msg.payload || []));
    if (!body) continue;
    const ev = toEvent(method, body, msg);
    if (ev) events.push(ev);
  }
  return { events, meta };
}

function toEvent(method, body, envelope) {
  const now = Date.now();
  const comboId = str(envelope.msgId);
  switch (method) {
    case 'WebcastChatMessage': {
      const text = str(body.content);
      if (!text) return null;
      return make.comment(toViewer(body.user), text, now);
    }
    case 'WebcastEmojiChatMessage': {
      const text = str(body.defaultContent) || '[表情]';
      return make.comment(toViewer(body.user), text, now);
    }
    case 'WebcastGiftMessage': {
      const gift = body.gift || {};
      const unit = num(gift.diamondCount);
      const repeat = Math.max(1, num(body.repeatCount));
      const totalCount = Math.max(repeat, num(body.totalCount) || repeat);
      const ev = make.gift(
        toViewer(body.user),
        {
          id: str(num(body.giftId)) || str(gift.id) || str(gift.name),
          name: str(gift.name) || `礼物 ${num(body.giftId)}`,
          count: repeat,
          repeatEnd: num(body.repeatEnd) === 1,
          diamonds: unit,
          totalDiamonds: repeat * unit,
        },
        now,
      );
      ev.comboId = comboId;
      ev.totalCount = totalCount;
      return ev;
    }
    case 'WebcastLikeMessage':
      return make.like(toViewer(body.user), num(body.count) || 1, num(body.total), now);
    case 'WebcastSocialMessage': {
      // action 1 = 关注；其余（分享等）不当作可演出事件
      if (num(body.action) !== 1) return null;
      return make.follow(toViewer(body.user), now);
    }
    case 'WebcastMemberMessage': {
      // action 1 = 进直播间
      if (num(body.action) !== 1) return null;
      return make.enter(toViewer(body.user), now);
    }
    case 'WebcastRoomUserSeqMessage': {
      const viewers = num(body.totalUser) || num(body.total);
      return make.stats(viewers, num(body.popularity), now);
    }
    default:
      return null;
  }
}
