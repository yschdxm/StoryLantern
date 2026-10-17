import type { AppMessages } from './messages-types.ts';

/**
 * English shard for the world-pack editor (create / edit / delete via a bottom sheet).
 * Same key set as `catalog-zh-pack.ts`; merged in `messages.ts`.
 */
export const enPack: AppMessages = {
  'pack.new': 'New world pack',
  'pack.edit.title': 'Edit world pack: {{name}}',
  'pack.noStore': 'This storage backend has no world-pack store, so packs cannot be read or saved.',

  'pack.field.name': 'Name',
  'pack.field.name.placeholder': 'e.g. Frontier Town setting collection',
  'pack.field.name.required': 'A world-pack name is required.',
  'pack.field.version': 'Version',
  'pack.field.description': 'Description',
  'pack.field.description.placeholder': 'One line readers will see',
  'pack.field.author': 'Author',
  'pack.field.license': 'License',
  'pack.field.language': 'Language',
  'pack.field.tags': 'Tags',
  'pack.field.tags.hint': 'Comma separated, e.g. fantasy, frontier, low-magic',

  'pack.cards.title': 'Cards in this pack',
  'pack.cards.hint': '{{count}} selected. The order follows the order you picked them, not the alphabet.',
  'pack.cards.search': 'Search cards by name',
  'pack.cards.empty': 'No cards are available to add yet.',
  'pack.cards.noMatch': 'No cards match this search.',
  'pack.warning.noCards': 'No cards selected: an empty pack can be saved, but it will bring nothing when exported or mounted.',
  'pack.cardType.character': 'Character',
  'pack.cardType.scene': 'Scene',
  'pack.cardType.item': 'Item',
  'pack.cardType.lore': 'Lore',

  'pack.saveFailed': 'Could not save the world pack. Cause: {{message}}. Check the name and version, then try again; your input is still here.',
  'pack.delete': 'Delete world pack',
  'pack.delete.hint': 'Deleting removes only the pack, not the cards inside it.',
  'pack.delete.title': 'Delete world pack',
  'pack.delete.message': 'Delete “{{name}}”? The cards inside it will not be deleted, but sessions that mount this pack will lose them from their resource pool.',
  'pack.deleteFailed': 'Could not delete the world pack. Cause: {{message}}. Try again later; both the pack and its cards are still here.',
};
