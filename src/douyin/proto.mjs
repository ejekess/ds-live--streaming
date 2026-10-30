/**
 * 抖音直播推送协议的最小 protobuf 子集。
 *
 * 只声明这条链路上真正会用到的消息和字段，字段号对齐抖音 webcast 线上协议
 * （对照 saermart/DouyinLiveWebFetcher 的 protobuf/douyin.proto 核实，AGPL-3.0，
 * 这里只取字段编号这一事实性信息，没有拷贝其实现；本文件按本项目许可发布）。
 *
 * 为什么只取子集：全量 proto 有几十个 message、上千字段，解码开销和心智负担都不划算；
 * 少一个字段最坏是少一个信息，多认一个错字段则会让整条链路静默出错，所以宁可窄。
 */
import protobuf from 'protobufjs';

export const PROTO_SOURCE = `
syntax = "proto3";
package douyin;

message PushFrame {
  uint64 seqId = 1;
  uint64 logId = 2;
  uint64 service = 3;
  uint64 method = 4;
  repeated HeadersList headersList = 5;
  string payloadEncoding = 6;
  string payloadType = 7;
  bytes payload = 8;
}

message HeadersList {
  string key = 1;
  string value = 2;
}

message Response {
  repeated Message messagesList = 1;
  string cursor = 2;
  uint64 fetchInterval = 3;
  uint64 now = 4;
  string internalExt = 5;
  uint32 fetchType = 6;
  map<string, string> routeParams = 7;
  uint64 heartbeatDuration = 8;
  bool needAck = 9;
  string pushServer = 10;
  string liveCursor = 11;
  bool historyNoMore = 12;
}

message Message {
  string method = 1;
  bytes payload = 2;
  int64 msgId = 3;
  int32 msgType = 4;
  int64 offset = 5;
  bool needWrdsStore = 6;
  int64 wrdsVersion = 7;
  string wrdsSubKey = 8;
}

message Common {
  string method = 1;
  uint64 msgId = 2;
  uint64 roomId = 3;
  uint64 createTime = 4;
  uint32 monitor = 5;
  bool isShowMsg = 6;
  string describe = 7;
  uint64 foldType = 9;
  uint64 anchorFoldType = 10;
  uint64 priorityScore = 11;
  string logId = 12;
  User user = 15;
}

message User {
  uint64 id = 1;
  uint64 shortId = 2;
  string nickName = 3;
  uint32 gender = 4;
  string signature = 5;
  uint32 level = 6;
  uint32 experience = 13;
  string city = 14;
  FollowInfo followInfo = 22;
  PayGrade payGrade = 23;
  FansClub fansClub = 24;
  string displayId = 38;
  string secUid = 46;
  uint64 fanTicketCount = 1022;
  string idStr = 1028;
}

message FollowInfo {
  uint64 followingCount = 1;
  uint64 followerCount = 2;
  uint64 followStatus = 3;
  uint64 pushStatus = 4;
  string remarkName = 5;
}

message PayGrade {
  int64 totalDiamondCount = 1;
  string name = 3;
  int64 level = 6;
}

message FansClub {
  FansClubData data = 1;
}

message FansClubData {
  string clubName = 1;
  int32 level = 2;
  int32 userFansClubStatus = 3;
  int64 anchorId = 6;
}

message ChatMessage {
  Common common = 1;
  User user = 2;
  string content = 3;
  bool visibleToSender = 4;
  string fullScreenTextColor = 6;
  uint64 agreeMsgId = 11;
  uint32 priorityLevel = 12;
  uint64 eventTime = 15;
  string chatBy = 20;
}

message EmojiChatMessage {
  Common common = 1;
  User user = 2;
  int64 emojiId = 3;
  string defaultContent = 5;
  bool fromIntercom = 7;
}

message GiftMessage {
  Common common = 1;
  uint64 giftId = 2;
  uint64 fanTicketCount = 3;
  uint64 groupCount = 4;
  uint64 repeatCount = 5;
  uint64 comboCount = 6;
  User user = 7;
  User toUser = 8;
  uint32 repeatEnd = 9;
  uint64 groupId = 11;
  uint64 roomFanTicketCount = 13;
  GiftStruct gift = 15;
  string logId = 16;
  uint64 sendType = 17;
  uint64 totalCount = 29;
  uint64 sendTime = 33;
  string traceId = 35;
}

message GiftStruct {
  string describe = 2;
  bool notify = 3;
  uint64 duration = 4;
  uint64 id = 5;
  bool combo = 10;
  uint32 type = 11;
  uint32 diamondCount = 12;
  string name = 16;
  string region = 17;
  bool forCustom = 19;
  uint32 actionType = 22;
}

message LikeMessage {
  Common common = 1;
  uint64 count = 2;
  uint64 total = 3;
  uint64 color = 4;
  User user = 5;
  string icon = 6;
  uint64 linkmicGuestUid = 9;
  string scene = 10;
}

message SocialMessage {
  Common common = 1;
  User user = 2;
  uint64 shareType = 3;
  uint64 action = 4;
  string shareTarget = 5;
  uint64 followCount = 6;
}

message MemberMessage {
  Common common = 1;
  User user = 2;
  uint64 memberCount = 3;
  uint64 enterType = 9;
  uint64 action = 10;
  string actionDescription = 11;
  uint64 userId = 12;
  string popStr = 14;
}

message RoomUserSeqMessage {
  Common common = 1;
  int64 total = 3;
  string popStr = 4;
  int64 popularity = 6;
  int64 totalUser = 7;
  string totalUserStr = 8;
  string onlineUserForAnchor = 10;
}
`;

const root = protobuf.parse(PROTO_SOURCE, { keepCase: true }).root;

const T = {
  PushFrame: root.lookupType('douyin.PushFrame'),
  Response: root.lookupType('douyin.Response'),
  Message: root.lookupType('douyin.Message'),
  Chat: root.lookupType('douyin.ChatMessage'),
  EmojiChat: root.lookupType('douyin.EmojiChatMessage'),
  Gift: root.lookupType('douyin.GiftMessage'),
  Like: root.lookupType('douyin.LikeMessage'),
  Social: root.lookupType('douyin.SocialMessage'),
  Member: root.lookupType('douyin.MemberMessage'),
  RoomUserSeq: root.lookupType('douyin.RoomUserSeqMessage'),
};

/** 方法名 → 解码器。没列出来的推送直接忽略（比如房间统计、控制帧）。 */
const METHOD_TYPES = {
  WebcastChatMessage: T.Chat,
  WebcastEmojiChatMessage: T.EmojiChat,
  WebcastGiftMessage: T.Gift,
  WebcastLikeMessage: T.Like,
  WebcastSocialMessage: T.Social,
  WebcastMemberMessage: T.Member,
  WebcastRoomUserSeqMessage: T.RoomUserSeq,
};

export function decodePushFrame(buffer) {
  return T.PushFrame.decode(buffer);
}

export function decodeResponse(buffer) {
  return T.Response.decode(buffer);
}

/** 按 method 解出具体消息；未知方法返回 null。 */
export function decodePayload(method, buffer) {
  const type = METHOD_TYPES[method];
  if (!type) return null;
  try {
    return type.decode(buffer);
  } catch {
    return null;
  }
}

export function knowsMethod(method) {
  return method in METHOD_TYPES;
}

export const METHOD_NAMES = Object.keys(METHOD_TYPES);

/** 只在自检脚本里用来构造测试帧；业务代码不应该直接拿这些类型编码。 */
export const Types = T;
