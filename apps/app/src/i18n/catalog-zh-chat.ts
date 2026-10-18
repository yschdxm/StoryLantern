import type { AppMessages } from './messages-types.ts';

/** 中文分片：聊天思考链 / 引用 / 消息详情 / 请求详情 / 引用模式设置。 */
export const zhChat: AppMessages = {
  'chat.trace.block.postHistory': 'post-history 指令（对话末尾）',
  'chat.trace.block.empty': '无内容',
  'settings.model.cite': '引用模式',
  'settings.model.cite.hint':
    '开启后模型会在句末标注来源编号，并显示为可点开的引用 chip；关闭则不编号（默认关闭，普通角色扮演不会出现 [16]）。',

  'chat.stopped': '已停止',
  'chat.reasoning.title': '思考过程（{{count}} 字）',
  'chat.reasoning.streaming': '思考中…（{{count}} 字）',
  'chat.citation.missing': '无法对应',
  'chat.citation.unresolved': '引用无法对应：{{count}} 条',
  'chat.citation.preview': '来源：{{text}}',

  'chat.detail.action': '查看详情',
  'chat.detail.title': '消息详情',
  'chat.detail.none': '这条消息没有生成元数据（可能是旧消息）。',
  'chat.detail.model': '模型',
  'chat.detail.model.value': '{{label}}（{{id}}）',
  'chat.detail.tokens': 'token（估算）',
  'chat.detail.tokens.value': '输入 {{prompt}} · 输出 {{completion}}',
  'chat.detail.timing': '耗时',
  'chat.detail.timing.value': '首字 {{first}} ms · 总耗时 {{total}} ms',
  'chat.detail.reasoning': '思考过程全文',
  'chat.detail.citations': '引用',
  'chat.detail.citations.none': '这条回复没有引用。',
  'chat.detail.citation.line': '[{{index}}] → {{target}}',
  'chat.detail.citation.missing': '[{{index}}] 无法对应',
  'chat.detail.error': '错误原因',
  'chat.detail.status.stopped': '这条回复被用户停止，已保留收到的内容。',

  'chat.request.button': '请求详情',
  'chat.request.title': '请求详情',
  'chat.request.unavailable': '这次调用没有拿到请求预览（宿主未返回或预览失败）：{{message}}',
  'chat.request.model': '模型 {{model}}',
  'chat.request.url': 'URL',
  'chat.request.bytes': '{{bytes}} 字节',
  'chat.request.body': '真实请求体（就是即将发出去的那一份）',
  'chat.request.postHistory': 'post-history 指令',
  'chat.request.diff': '与上一轮的差异（{{count}} 行变化）',
  'chat.request.diff.same': '与上一轮请求相同。',
  'chat.request.diff.first': '首轮请求（没有上一轮可比较）。',
  'chat.request.copy.json': '复制 JSON',
  'chat.request.copy.curl': '复制 cURL',
  'chat.request.copy.ok': '已复制。',
  'chat.request.copy.failed':
    '复制失败：浏览器没有允许访问剪贴板。请长按/选中文本手动复制；或检查系统剪贴板权限。请求内容本身不受影响。',
  'chat.request.masking': 'Authorization 在 cURL 里固定脱敏为 Bearer ••••，不会带出密钥。',
};
