// What a chunk of a parallel render (tools/render-story.mjs --workers) takes over from the command line: every option that changes the picture or the script.
// test/story-map.test.mjs reads render-story.mjs: an option that is neither here nor in PARENT_ONLY fails the test.
export const CHUNK_VALUES = ['llm', 'llm-output', 'voices', 'class', 'casters-rounds', 'show', 'show-report', 'footer', 'story', 'theme', 'theme-names'];
export const CHUNK_FLAGS = ['no-fill'];
// set by the parent for each chunk, or only meaningful in the parent ('team-tint' and 'lod' (--lod0): the parent turns them into RTS_QUERY, the chunks inherit that variable)
export const PARENT_ONLY = ['no-precheck', 'no-draft-check', '_', 'target', 'out', 'preset', 'fps', 'crf', 'name', 'from-s', 'limit-s', 'warm', 'workers', 'audio', 'audio-only', 'stage', 'preview', 'team-tint', 'lod'];
export const chunkArgs = (A) => [...CHUNK_VALUES.filter((k) => typeof A[k] === 'string').flatMap((k) => [`--${k}`, A[k]]), ...CHUNK_FLAGS.filter((k) => A[k]).map((k) => `--${k}`)];
