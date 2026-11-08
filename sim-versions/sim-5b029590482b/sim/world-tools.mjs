// Tool definitions of the living world (chat, ferrying land units on a transport). Kept apart from sim/commands.mjs; the list is appended to TOOLS there.
import { CHAT } from './world-data.mjs';

export const WORLD_TOOLS = [
  {
    name: 'say',
    description: `Say a short message to your opponent. It shows as a speech bubble over your town center for everybody watching, and the opponent reads it in its next observation. Max ${CHAT.maxChars} characters, one message per ${CHAT.gapTicks / 10} seconds. No game effect: use it for banter, bluffs or a taunt.`,
    parameters: { type: 'object', properties: { text: { type: 'string', maxLength: CHAT.maxChars } }, required: ['text'] },
  },
  {
    name: 'board',
    description: 'Land units walk to a transport ship that lies at the shore (within 4 tiles of land) and climb aboard. A transport carries up to 6 land units (no siege). Boarded units count for your population and disappear from the map until unloaded.',
    parameters: { type: 'object', properties: { units: {}, transport_id: { type: 'integer' } }, required: ['units', 'transport_id'] },
  },
  {
    name: 'unload',
    description: 'A transport sails to the water tile nearest to the land tile `to` [x, y] and puts all its cargo ashore there. Without `to` it lands next to the nearest shore.',
    parameters: { type: 'object', properties: { transport_id: { type: 'integer' }, to: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } }, required: ['transport_id'] },
  },
];
