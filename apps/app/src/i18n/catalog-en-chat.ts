import type { AppMessages } from './messages-types.ts';

/** English shard for reasoning / citations / message detail / request detail / citation mode. */
export const enChat: AppMessages = {
  'chat.trace.block.postHistory': 'post-history instruction (end of conversation)',
  'chat.trace.block.empty': 'empty',
  'settings.model.cite': 'Citation mode',
  'settings.model.cite.hint':
    'When on, the model marks source indices at the end of sentences and they render as tappable citation chips; when off (default) nothing is numbered, so ordinary roleplay never shows [16].',

  'chat.stopped': 'Stopped',
  'chat.reasoning.title': 'Reasoning ({{count}} chars)',
  'chat.reasoning.streaming': 'Thinking… ({{count}} chars)',
  'chat.citation.missing': 'unresolved',
  'chat.citation.unresolved': 'Unresolved citations: {{count}}',
  'chat.citation.preview': 'Source: {{text}}',

  'chat.detail.action': 'View details',
  'chat.detail.title': 'Message details',
  'chat.detail.none': 'This message has no generation metadata (likely an older message).',
  'chat.detail.model': 'Model',
  'chat.detail.model.value': '{{label}} ({{id}})',
  'chat.detail.tokens': 'Tokens (estimated)',
  'chat.detail.tokens.value': 'prompt {{prompt}} · completion {{completion}}',
  'chat.detail.timing': 'Timing',
  'chat.detail.timing.value': 'first delta {{first}} ms · total {{total}} ms',
  'chat.detail.reasoning': 'Full reasoning',
  'chat.detail.citations': 'Citations',
  'chat.detail.citations.none': 'This reply has no citations.',
  'chat.detail.citation.line': '[{{index}}] → {{target}}',
  'chat.detail.citation.missing': '[{{index}}] unresolved',
  'chat.detail.error': 'Error reason',
  'chat.detail.status.stopped': 'This reply was stopped; received content was kept.',

  'chat.request.button': 'Request details',
  'chat.request.title': 'Request details',
  'chat.request.unavailable': 'No request preview for this call (host did not return one or preview failed): {{message}}',
  'chat.request.model': 'Model {{model}}',
  'chat.request.url': 'URL',
  'chat.request.bytes': '{{bytes}} bytes',
  'chat.request.body': 'Actual request body (the exact payload to be sent)',
  'chat.request.postHistory': 'post-history instruction',
  'chat.request.diff': 'Diff vs previous turn ({{count}} changed lines)',
  'chat.request.diff.same': 'Same as the previous request.',
  'chat.request.diff.first': 'First request (nothing previous to compare).',
  'chat.request.copy.json': 'Copy JSON',
  'chat.request.copy.curl': 'Copy cURL',
  'chat.request.copy.ok': 'Copied.',
  'chat.request.copy.failed':
    'Copy failed: the browser did not allow clipboard access. Select the text and copy manually, or check clipboard permission; the request content is unaffected.',
  'chat.request.masking': 'Authorization is always masked as Bearer •••• in cURL; no key is exposed.',
};
