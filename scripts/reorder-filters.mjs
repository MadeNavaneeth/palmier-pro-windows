import fs from 'node:fs';
const p = 'src/main/media/export-args.ts';
let s = fs.readFileSync(p, 'utf8');
const startFilter = s.indexOf('  if (filters.length > 0) {');
const endMarker = '  // Output settings';
const endIdx = s.indexOf(endMarker);
if (startFilter === -1 || endIdx === -1) {
  console.log('anchors missing', startFilter, endIdx);
  process.exit(1);
}
const lines = [
  '  let currentVideo: string;',
  '  if (videoClips.length > 0) {',
  "    currentVideo = '[vout]';",
  '  } else if (!audioOnly) {',
  "    currentVideo = '0:v';",
  '  } else {',
  "    currentVideo = ''; // audio-only exports have no video output",
  '  }',
  '  if (!audioOnly) {',
  '    let titleIndex = 0;',
  '    for (const clip of sortedClips) {',
  "      if (clip.type !== 'title' || !clip.text) continue;",
  '      const outLabel = `[vt${titleIndex}]`;',
  '      filters.push(',
  "        `${currentVideo}drawtext=text='${escapeDrawtext(clip.text)}'`",
  '        + `:fontsize=${Math.round((clip.titleSizeRatio ?? 0.09) * height)}`',
  "        + `:fontcolor=${clip.titleColor ?? 'white'}`",
  '        + `:x=(w-text_w)/2:y=(h-text_h)/2`',
  "        + `:enable='between(t,${(clip.startFrame / fps).toFixed(4)},${((clip.startFrame + clip.durationFrames) / fps).toFixed(4)})'`",
  '        + outLabel,',
  '      );',
  '      currentVideo = outLabel;',
  '      titleIndex += 1;',
  '    }',
  '    args.push(`-map`, currentVideo);',
  '  } else if (audioMap) {',
  '    args.push(`-map`, audioMap);',
  '  }',
  '',
];
s = s.slice(0, startFilter) + lines.join('\n') + '\n' + s.slice(endIdx);
fs.writeFileSync(p, s);
console.log('rewritten OK');
