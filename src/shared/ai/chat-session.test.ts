import { describe, expect, it } from 'vitest';
import { adoptChatSession } from './chat-session';

const TOOL_TURN = [
  { role: 'user', content: 'Check the timeline' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Checking now.' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_timeline', input: { detail: 'full' } },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"clips":3}' },
    ],
  },
  { role: 'assistant', content: 'Three clips.' },
];

describe('adoptChatSession (#286)', () => {
  it('converts plain user and assistant turns to messages', () => {
    const { messages, plan } = adoptChatSession(
      [
        { role: 'user', content: 'Trim the intro' },
        { role: 'assistant', content: 'Done.' },
      ],
      [],
    );

    expect(messages).toEqual([
      { role: 'user', content: 'Trim the intro' },
      { role: 'assistant', content: 'Done.' },
    ]);
    expect(plan).toEqual([]);
  });

  it('rebuilds tool_use/tool_result pairs as call and result receipts', () => {
    const { messages } = adoptChatSession(TOOL_TURN, []);

    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    const [call, result] = messages.slice(2, 4);
    expect(call.toolName).toBe('get_timeline');
    expect(call.toolArgs).toEqual({ detail: 'full' });
    expect(result.toolName).toBe('get_timeline → result');
    expect(result.success).toBe(true);
    expect(result.content).toBe('{"clips":3}');
    expect(messages[4].content).toBe('Three clips.');
  });

  it('keeps user text that shares a turn with tool results', () => {
    const { messages } = adoptChatSession(
      [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'get_timeline', input: {} }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
            { type: 'text', text: 'Now trim it' },
          ],
        },
      ],
      [],
    );

    expect(messages.map((message) => message.role)).toEqual(['tool', 'tool', 'user']);
    expect(messages[2].content).toBe('Now trim it');
  });

  it('renders an unpaired call without swallowing it', () => {
    const { messages } = adoptChatSession(
      [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't9', name: 'get_timeline', input: {} }],
        },
      ],
      [],
    );

    expect(messages).toEqual([
      { role: 'tool', content: '{}', toolName: 'get_timeline', toolArgs: {} },
    ]);
  });

  it('marks errored results as failures', () => {
    const { messages } = adoptChatSession(
      [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'get_timeline', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Stopped.', is_error: true }],
        },
      ],
      [],
    );

    expect(messages[1].success).toBe(false);
  });

  it('reads text out of tool_result block arrays', () => {
    const { messages } = adoptChatSession(
      [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'get_timeline', input: {} }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'three' }] },
          ],
        },
      ],
      [],
    );

    expect(messages[1].content).toBe('three');
  });

  it('skips orphan results, unknown roles, and empty text', () => {
    const { messages } = adoptChatSession(
      [
        null,
        'nope',
        { role: 'system', content: 'prompt' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'x' }] },
        { role: 'assistant', content: '' },
        { role: 'assistant', content: [{ type: 'thinking', text: 'hmm' }] },
        { role: 'user', content: 42 },
      ],
      [],
    );

    expect(messages).toEqual([]);
  });

  it('accepts both plan key spellings and normalizes the checklist', () => {
    const { plan } = adoptChatSession([], [
      { title: 'Trim the intro', status: 'in_progress' },
      { step: 'Add titles', status: 'bogus' },
      { step: '', status: 'pending' },
      'nope',
    ]);

    expect(plan).toEqual([
      { step: 'Trim the intro', status: 'in_progress' },
      { step: 'Add titles', status: 'pending' },
    ]);
  });

  it('degrades malformed payloads to an empty chat', () => {
    expect(adoptChatSession(null, null)).toEqual({ messages: [], plan: [] });
    expect(adoptChatSession('history', { steps: [] })).toEqual({ messages: [], plan: [] });
    expect(adoptChatSession([null, 42], 'plan')).toEqual({ messages: [], plan: [] });
  });
});
