import { stripCitationMarkers } from '../../data/citations.ts';
import type { Message } from '../../data/types.ts';

/**
 * 气泡里展示的正文：**assistant** 的消息去掉引用标记（只改展示，不改库），
 * 用户消息原样（用户可能真的想打 `[1]`）。旧消息没有 meta，也同样按这个规则展示。
 */
export function displayContentOf(message: Message): string {
  return message.role === 'assistant' ? stripCitationMarkers(message.content) : message.content;
}

/** 引用 chip 的预览文本：压成一行、截断，避免把整条消息塞进气泡。 */
export function previewOfSource(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat === '') return undefined;
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}
