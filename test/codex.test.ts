import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  callRule,
  checkCommandPaths,
  classifyCodexText,
  CODEX_DECLARED,
  codexExecArgs,
  codexPreflight,
  createCodexAdapter,
  judgePromptInput,
  ratifyCodexLeg,
  READ_COMMAND_NAMES,
  READ_COMMANDS,
  readCommandUsage,
  scanExecInput,
  sedScriptProblem,
  type CodexRatifyInput,
} from '../src/adapters/codex/index.js';
import { CODEX_ENV_ALLOW, CODEX_READ_PREFACE } from '../src/adapters/codex/launch.js';
import { rootAliases } from '../src/adapters/paths.js';
import { fromNonceLine, type Occupant, type RoundCtx } from '../src/adapters/types.js';
import { runCommand } from '../src/transport/headless.js';
import { cleanScratchAfterAll, fixtureDir, listFiles, materialize, readJsonl, scratch, writeJsonl } from './helpers/fixtures.js';

cleanScratchAfterAll();

interface CaseFile {
  nonce: string;
  model: string;
  effort: string;
  cliVersion: string;
  startedAt: string;
  rootMutated: boolean;
  expect: { status: string; failureClass: string | null; failed: string[] };
}

const CASES = readdirSync(fixtureDir('codex', '')).filter((n) => existsSync(join(fixtureDir('codex', n), 'case.json')));

function caseOf(name: string): CaseFile {
  return JSON.parse(readFileSync(join(fixtureDir('codex', name), 'case.json'), 'utf8')) as CaseFile;
}

function inputFor(name: string, edit?: (dir: string) => void, mutated?: boolean): { input: CodexRatifyInput; dir: string; root: string } {
  const c = caseOf(name);
  const { dir, root } = materialize('codex', name);
  edit?.(dir);
  const changed = mutated ?? c.rootMutated;
  return {
    dir,
    root,
    input: {
      root,
      nonce: c.nonce,
      model: c.model,
      effort: c.effort,
      cliVersion: c.cliVersion,
      codexHome: join(dir, 'codex-home'),
      eventsFile: join(dir, 'events.jsonl'),
      stderrFile: join(dir, 'stderr.log'),
      lastFile: join(dir, 'last.txt'),
      startedAt: new Date(c.startedAt),
      timedOut: false,
      rootUnchanged: () => ({ unchanged: !changed, changes: changed ? ['modified planted/calc/rangesum.py'] : [] }),
    },
  };
}

function rolloutsOf(dir: string): string[] {
  return listFiles(join(dir, 'codex-home', 'sessions'))
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
}

const failedNames = (r: ReturnType<typeof ratifyCodexLeg>): string[] => r.checks.filter((c) => !c.ok).map((c) => c.name).sort();

describe('codex replay: every recorded and synthetic case', () => {
  it('has the cases the brief names', () => {
    expect(CASES.sort()).toEqual(
      [
        'auth',
        'child-fails',
        'contaminated-offered',
        'contaminated-used',
        'delegating',
        'empty',
        'exec-only-offer14',
        'interpreter-cmd',
        'nested-introspection',
        'outside-root-cmd',
        'root-mutated',
        'success',
        'usage-limit',
        'write-denial',
        'wrong-model',
      ].sort(),
    );
  });

  it.each(CASES)('%s', (name) => {
    const c = caseOf(name);
    const r = ratifyCodexLeg(inputFor(name).input);
    expect({ status: r.status, failureClass: r.failureClass, failed: failedNames(r) }).toEqual({
      status: c.expect.status,
      failureClass: c.expect.failureClass,
      failed: [...c.expect.failed].sort(),
    });
  });
});

describe('codex ratification details', () => {
  it('records the fields 4.5 lists from the success leg', () => {
    const r = ratifyCodexLeg(inputFor('success').input);
    expect(r).toMatchObject({
      status: 'PASS',
      enforcement: 'sandboxed-exec',
      sessionId: '00000000-0000-7000-8000-000000000001',
      cliVersion: '0.167.0',
      modelObserved: 'gpt-6.1-sol',
      effortObserved: 'low',
      cwdOk: true,
      nonceSeen: true,
      rootMutated: false,
      tokensIn: 62919,
      tokensOut: 390,
      quotaUsedPct: 42,
      durationMs: 17205,
    });
    expect(r.quotaNote).toBe('plan plus; 300 min window 6%, 10080 min window 42%');
    expect(r.toolsOffered).toEqual(CODEX_DECLARED['0.167.0']?.nativeOffer);
    expect(r.toolsUsed).toEqual(['functions.exec']);
  });

  it('ratifies the delegating leg and its child under the same checks, mapping calls to offers (N27, N28, N30)', () => {
    const r = ratifyCodexLeg(inputFor('delegating').input);
    expect(r.status).toBe('PASS');
    const threads = r.detail['threads'] as Array<{ role: string; agentPath: string; failed: string[]; model: string; effort: string }>;
    expect(threads.map((t) => [t.role, t.agentPath, t.model, t.effort, t.failed])).toEqual([
      ['leg', '/root', 'gpt-6.1-sol', 'low', []],
      ['child', '/root/read_b', 'gpt-6.1-sol', 'low', []],
    ]);
    expect(r.toolsUsed).toEqual(['collaboration.send_message', 'collaboration.spawn_agent', 'collaboration.wait_agent', 'functions.exec']);
    expect(r.checks.find((c) => c.name === 'children')?.detail).toBe('1 subagent(s), each ratified');
  });

  const childEdit = (field: string, value: unknown) => (dir: string) => {
    const child = rolloutsOf(dir)[1] as string;
    const rows = readJsonl(child).map((row) => {
      if (row['type'] === 'turn_context' && Number(row['ordinal']) >= 17) (row['payload'] as Record<string, unknown>)[field] = value;
      return row;
    });
    writeJsonl(child, rows);
  };

  it.each([
    ['model', 'gpt-6-luna', 'model'],
    ['effort', 'high', 'effort'],
    ['approval_policy', 'on-request', 'approval'],
    ['sandbox_policy', { type: 'danger-full-access' }, 'sandbox'],
    ['permission_profile', { type: 'managed', network: 'enabled' }, 'network'],
  ])("fails when a child's own %s differs (N30)", (field, value, check) => {
    const r = ratifyCodexLeg(inputFor('delegating', childEdit(field, value)).input);
    expect(r.status).toBe('CONTAMINATED');
    expect(failedNames(r)).toEqual(['children']);
    expect(r.checks.find((c) => c.name === 'children')?.detail).toContain(`${check}:`);
  });

  it("ignores the forked parent history in a child's rollout (its aborted turn and the parent's spawn call)", () => {
    // The child rollout carries the parent's turn_aborted and spawn_agent before subagent_history_start_ordinal.
    const { dir, input } = inputFor('delegating');
    const child = readJsonl(rolloutsOf(dir)[1] as string);
    expect(child.some((r) => (r['payload'] as Record<string, unknown>)['type'] === 'turn_aborted')).toBe(true);
    expect(ratifyCodexLeg(input).status).toBe('PASS');
  });

  it('fails when a spawned child has no rollout (N12)', () => {
    const r = ratifyCodexLeg(inputFor('delegating', (dir) => rmSync(rolloutsOf(dir)[1] as string)).input);
    expect(r.status).toBe('CONTAMINATED');
    expect(r.checks.find((c) => c.name === 'children')?.detail).toContain('record: no rollout found');
  });

  it('finds a child that only names the leg as its parent (scan, N12)', () => {
    const { dir, input } = inputFor('delegating', (d) => {
      // Drop every SubAgentActivity from the leg: the child is then found only by its parent_thread_id.
      const leg = rolloutsOf(d)[0] as string;
      writeJsonl(
        leg,
        readJsonl(leg).filter((row) => {
          const item = ((row['payload'] as Record<string, unknown>)['item'] ?? {}) as Record<string, unknown>;
          return item['type'] !== 'SubAgentActivity';
        }),
      );
      // The child also fails, so a found-by-scan child is provably ratified.
      childEdit('effort', 'max')(d);
    });
    void dir;
    const r = ratifyCodexLeg(input);
    expect(r.checks.find((c) => c.name === 'children')?.detail).toContain('effort:');
  });

  it("fails an orchestration call on an agent outside the leg's tree (N30)", () => {
    const r = ratifyCodexLeg(
      inputFor('delegating', (dir) => {
        const leg = rolloutsOf(dir)[0] as string;
        writeJsonl(
          leg,
          readJsonl(leg).map((row) => {
            const p = row['payload'] as Record<string, unknown>;
            if (p['type'] === 'function_call' && p['name'] === 'send_message') {
              p['arguments'] = JSON.stringify({ target: '11111111-2222-7333-8444-555555555555', message: 'x' });
            }
            const item = (p['item'] ?? {}) as Record<string, unknown>;
            if (item['type'] === 'SubAgentActivity' && item['kind'] === 'interacted') item['agent_thread_id'] = '11111111-2222-7333-8444-555555555555';
            return row;
          }),
        );
      }).input,
    );
    expect(r.status).toBe('CONTAMINATED');
    expect(failedNames(r)).toEqual(['targets']);
  });

  it('fails a command that ran but appears in no exec script (N16 cross-check)', () => {
    const r = ratifyCodexLeg(
      inputFor('success', (dir) => {
        const leg = rolloutsOf(dir)[0] as string;
        writeJsonl(
          leg,
          readJsonl(leg).map((row) => {
            const item = ((row['payload'] as Record<string, unknown>)['item'] ?? {}) as Record<string, unknown>;
            if (item['type'] === 'CommandExecution' && Array.isArray(item['command'])) item['command'] = ['/bin/zsh', '-lc', 'cat notes.txt'];
            return row;
          }),
        );
      }).input,
    );
    expect(failedNames(r)).toEqual(['commands']);
    expect(r.checks.find((c) => c.name === 'commands')?.detail).toContain('ran but not in any exec script');
  });

  const legEdit = (change: (row: Record<string, unknown>, rows: Array<Record<string, unknown>>) => void) => (dir: string) => {
    const leg = rolloutsOf(dir)[0] as string;
    const rows = readJsonl(leg);
    for (const row of [...rows]) change(row, rows);
    writeJsonl(leg, rows);
  };

  it.each([
    ['a session_meta from another originator', 'originator', legEdit((row) => {
      if (row['type'] === 'session_meta') (row['payload'] as Record<string, unknown>)['originator'] = 'codex_tui';
    })],
    ['a turn_context cwd outside the root', 'cwd', legEdit((row) => {
      if (row['type'] === 'turn_context') (row['payload'] as Record<string, unknown>)['cwd'] = '/elsewhere';
    })],
    ['a turn_context with no network policy (round 1)', 'network', legEdit((row) => {
      if (row['type'] === 'turn_context') delete ((row['payload'] as Record<string, Record<string, unknown>>)['permission_profile'] as Record<string, unknown>)['network'];
    })],
    ['a turn_context with the network enabled (round 1)', 'network', legEdit((row) => {
      if (row['type'] === 'turn_context') ((row['payload'] as Record<string, Record<string, unknown>>)['permission_profile'] as Record<string, unknown>)['network'] = 'enabled';
    })],
    ['a turn_context with no permission profile (round 1)', 'network', legEdit((row) => {
      if (row['type'] === 'turn_context') delete (row['payload'] as Record<string, unknown>)['permission_profile'];
    })],
    ['a model_reroute event in the rollout', 'no-reroute', legEdit((row, rows) => {
      if (row['type'] === 'turn_context') rows.push({ timestamp: 'x', type: 'event_msg', payload: { type: 'model_reroute', from_model: 'gpt-6.1-sol', to_model: 'gpt-6-luna' } });
    })],
  ])('fails on %s', (_what, check, change) => {
    const r = ratifyCodexLeg(inputFor('success', change).input);
    expect(failedNames(r)).toEqual([check]);
  });

  const commandCwd = (cwd: (root: string) => string | null) =>
    legEdit((row) => {
      const item = ((row['payload'] as Record<string, unknown>)['item'] ?? {}) as Record<string, unknown>;
      if (item['type'] === 'CommandExecution') item['cwd'] = cwd(String(item['cwd']).replace(/^file:\/\//, ''));
    });

  it.each([
    ['outside the root', (root: string) => `file://${root}/../elsewhere`],
    ['in a directory below the root', (root: string) => `file://${root}/calc`],
    ['with no cwd', () => null],
  ])('fails a CommandExecution that ran %s (round 1)', (_what, cwd) => {
    const r = ratifyCodexLeg(inputFor('success', commandCwd(cwd)).input);
    expect(failedNames(r)).toEqual(['commands']);
    expect(r.checks.find((c) => c.name === 'commands')?.detail).toContain('not the root');
  });

  it('fails an event stream whose last line is torn (round 1)', () => {
    const r = ratifyCodexLeg(
      inputFor('success', (dir) => writeFileSync(join(dir, 'events.jsonl'), `${readFileSync(join(dir, 'events.jsonl'), 'utf8')}{"type":"item.comp`)).input,
    );
    expect(failedNames(r)).toEqual(['events']);
    expect(r.checks.find((c) => c.name === 'events')?.detail).toContain('torn');
  });

  describe('the records backstop: every recorded item is declared, every image read is inside the root', () => {
    /** Adds one recorded item to the success leg, cloned from its own CommandExecution row. */
    const run = (item: () => Record<string, unknown>): ReturnType<typeof ratifyCodexLeg> =>
      ratifyCodexLeg(
        inputFor('success', (dir) => {
          const leg = rolloutsOf(dir)[0] as string;
          const rows = readJsonl(leg);
          const at = rows.findIndex((row) => (((row['payload'] as Record<string, unknown>)['item'] ?? {}) as Record<string, unknown>)['type'] === 'CommandExecution');
          const clone = JSON.parse(JSON.stringify(rows[at])) as Record<string, unknown>;
          (clone['payload'] as Record<string, unknown>)['item'] = item();
          rows.splice(at + 1, 0, clone);
          writeJsonl(leg, rows);
        }).input,
      );

    it('passes an image read inside the root', () => {
      const r = ratifyCodexLeg(
        inputFor('success', (dir) => {
          const leg = rolloutsOf(dir)[0] as string;
          const rows = readJsonl(leg);
          const at = rows.findIndex((row) => (((row['payload'] as Record<string, unknown>)['item'] ?? {}) as Record<string, unknown>)['type'] === 'CommandExecution');
          const clone = JSON.parse(JSON.stringify(rows[at])) as Record<string, unknown>;
          const cwd = String(((rows[at]?.['payload'] as Record<string, unknown>)['item'] as Record<string, unknown>)['cwd'] ?? '').replace(/^file:\/\//, '');
          (clone['payload'] as Record<string, unknown>)['item'] = { type: 'ImageView', id: 'exec-img-1', path: `file://${cwd}/planted/calc/rangesum.py` };
          rows.splice(at + 1, 0, clone);
          writeJsonl(leg, rows);
        }).input,
      );
      expect(failedNames(r)).toEqual([]);
    });

    it.each([
      // A call the static scanner cannot read (a key built at run time) still leaves an item: measured on 0.167.0,
      // a nested view_image call records ImageView with a file:// path.
      ['an image read outside the root', () => ({ type: 'ImageView', id: 'exec-img-2', path: 'file:///etc/hosts' }), 'image read of file:///etc/hosts'],
      ['an image read with no path', () => ({ type: 'ImageView', id: 'exec-img-3' }), 'no readable path'],
      ['a patch (apply_patch)', () => ({ type: 'FileChange', id: 'exec-fc-1', changes: {}, status: 'completed' }), 'recorded FileChange item'],
      ['a web search', () => ({ type: 'Extension', id: 'exec-ws-1', kind: 'web.search' }), 'recorded Extension item'],
      ['an MCP read', () => ({ type: 'McpToolCall', id: 'exec-mcp-1', server: 'codex', tool: 'read_mcp_resource' }), 'MCP call codex.read_mcp_resource'],
      ['a call on a user MCP server', () => ({ type: 'McpToolCall', id: 'exec-mcp-2', server: 'notes', tool: 'list_mcp_resources' }), 'MCP call notes.list_mcp_resources'],
      ['an item type the version does not declare', () => ({ type: 'TerminalInteraction', id: 'exec-ti-1' }), 'recorded TerminalInteraction item'],
    ])('fails %s', (_what, item, detail) => {
      const r = run(item);
      expect(failedNames(r)).toContain('records');
      expect(r.checks.find((c) => c.name === 'records')?.detail).toContain(detail);
      // Round 2: a records failure contaminates the leg; it is never a setup failure.
      expect({ status: r.status, failureClass: r.failureClass }).toEqual({ status: 'CONTAMINATED', failureClass: 'contaminated' });
    });

    it('classes an outside image read alone as CONTAMINATED, not a setup failure (round 2)', () => {
      const r = run(() => ({ type: 'ImageView', id: 'exec-img-4', path: 'file:///etc/hosts' }));
      expect(failedNames(r)).toEqual(['records']);
      expect(r).toMatchObject({ status: 'CONTAMINATED', failureClass: 'contaminated', ok: false });
    });

    it('passes the runtime\'s own MCP resource list', () => {
      const r = run(() => ({ type: 'McpToolCall', id: 'exec-mcp-3', server: 'codex', tool: 'list_mcp_resources', arguments: '{}' }));
      expect(failedNames(r)).toEqual([]);
    });
  });

  it('passes a read whose output quotes denial text: a reviewed file cannot knock the seat out (P5 live round)', () => {
    const r = ratifyCodexLeg(
      inputFor('success', (dir) => {
        const leg = rolloutsOf(dir)[0] as string;
        writeJsonl(
          leg,
          readJsonl(leg).map((row) => {
            const item = ((row['payload'] as Record<string, unknown>)['item'] ?? {}) as Record<string, unknown>;
            if (item['type'] === 'CommandExecution') item['aggregated_output'] = 'plan text: the leg failed with "Permission denied" and EROFS\n';
            return row;
          }),
        );
      }).input,
    );
    expect(failedNames(r)).toEqual([]);
    expect(r.checks.find((c) => c.name === 'write-denial')?.detail).toContain('a note');
    // The note reaches round show and round wait through the ratification's notes (P5 fold row 15).
    expect(r.notes).toHaveLength(1);
    expect(r.notes?.[0]).toContain('Permission denied');
  });

  it('fails a rollout whose last line is torn', () => {
    const r = ratifyCodexLeg(inputFor('success', (dir) => writeFileSync(rolloutsOf(dir)[0] as string, `${readFileSync(rolloutsOf(dir)[0] as string, 'utf8')}{"type":"event_m`)).input);
    expect(failedNames(r)).toEqual(['completion']);
  });

  it('fails a rollout with a malformed line before its end', () => {
    const r = ratifyCodexLeg(
      inputFor('success', (dir) => {
        const leg = rolloutsOf(dir)[0] as string;
        const lines = readFileSync(leg, 'utf8').split('\n');
        lines.splice(3, 0, '{not json');
        writeFileSync(leg, lines.join('\n'));
      }).input,
    );
    expect(failedNames(r)).toEqual(['record-parse']);
  });

  it('treats a null in a world_state delta as a removed tool, not an offer', () => {
    const r = ratifyCodexLeg(
      inputFor('success', legEdit((row, rows) => {
        if (row['type'] === 'turn_context') rows.push({ timestamp: 'x', type: 'world_state', payload: { state: { top_level_tools: { mcp__example__run: null } } } });
      })).input,
    );
    expect(r.status).toBe('PASS');
  });

  const waitArgs = (args: Record<string, unknown>) => (dir: string) => {
    const leg = rolloutsOf(dir)[0] as string;
    let first = true;
    writeJsonl(
      leg,
      readJsonl(leg).map((row) => {
        const p = row['payload'] as Record<string, unknown>;
        if (first && p['type'] === 'function_call' && p['name'] === 'wait_agent') {
          p['arguments'] = JSON.stringify(args);
          first = false;
        }
        return row;
      }),
    );
  };

  it.each([
    ['thread_id', { thread_id: '11111111-2222-7333-8444-555555555555', timeout_ms: 10000 }],
    ['target', { target: '/root/someone_else' }],
    ['agent_id', { agent_id: '11111111-2222-7333-8444-555555555555' }],
    ['id', { id: 42 }],
  ])('fails a wait_agent whose string %s names an agent outside the tree (round 1)', (field, args) => {
    const r = ratifyCodexLeg(inputFor('delegating', waitArgs(args)).input);
    expect(failedNames(r)).toEqual(['targets']);
    expect(r.checks.find((c) => c.name === 'targets')?.detail).toContain(`wait_agent -> ${field}`);
  });

  it("accepts a wait_agent whose thread_id is the leg's own child", () => {
    const { input } = inputFor('delegating');
    const child = (ratifyCodexLeg(input).detail['threads'] as Array<{ thread: string; role: string }>).find((t) => t.role === 'child')?.thread as string;
    expect(ratifyCodexLeg(inputFor('delegating', waitArgs({ thread_id: child })).input).status).toBe('PASS');
  });

  it("fails a SubAgentActivity that acts on an agent outside the leg's tree, even with a resolvable call target", () => {
    const r = ratifyCodexLeg(
      inputFor('delegating', (dir) => {
        const leg = rolloutsOf(dir)[0] as string;
        writeJsonl(
          leg,
          readJsonl(leg).map((row) => {
            const item = (((row['payload'] as Record<string, unknown>)['item'] ?? {}) as Record<string, unknown>);
            if (item['type'] === 'SubAgentActivity' && item['kind'] === 'interacted') {
              // Not tied to any call: only the activity itself shows the foreign agent.
              item['agent_thread_id'] = '11111111-2222-7333-8444-555555555555';
              item['id'] = 'call_unmatched';
            }
            return row;
          }),
        );
      }).input,
    );
    expect(failedNames(r)).toEqual(['targets']);
    expect(r.checks.find((c) => c.name === 'targets')?.detail).toContain('interacted on 11111111-2222-7333-8444-555555555555');
  });

  it('refuses an undeclared CLI version outright', () => {
    const { input } = inputFor('success');
    const r = ratifyCodexLeg({ ...input, cliVersion: '0.168.0' });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'cli-version')?.detail).toContain('no declared native list');
  });

  it('fails closed with no residue sweep', () => {
    const { input } = inputFor('success');
    const r = ratifyCodexLeg({ ...input, rootUnchanged: undefined });
    expect(failedNames(r)).toEqual(['root-unchanged']);
  });

  // Round 1 (2/3), plan 4.5 item 8: only a verbatim first NONCE line counts.
  it.each([
    ['the nonce mid-sentence', 'My review for b5c6831e146e follows.\n\nVERDICT: SHIP'],
    ['the nonce on line 2', 'Review below.\nNONCE: b5c6831e146e\n\nVERDICT: SHIP'],
    ['the nonce quoted from the brief', 'The brief said:\n> NONCE: b5c6831e146e\n\nVERDICT: SHIP'],
  ])('fails an answer with %s', (_what, text) => {
    const r = ratifyCodexLeg(inputFor('success', (dir) => writeFileSync(join(dir, 'last.txt'), text)).input);
    expect(failedNames(r)).toEqual(['nonce']);
    expect(r.nonceSeen).toBe(false);
  });

  it('accepts blank lines and wrappers before a verbatim NONCE line', () => {
    const r = ratifyCodexLeg(inputFor('success', (dir) => writeFileSync(join(dir, 'last.txt'), '\n\n**NONCE: b5c6831e146e**\n\nVERDICT: SHIP')).input);
    expect(r.status).toBe('PASS');
  });

  it('collects from the NONCE line only when it is the first non-empty line, never dropping text before a later one', () => {
    expect(fromNonceLine('\n\nNONCE: b5c6831e146e\nbody', 'b5c6831e146e', 'x')).toEqual({ text: 'NONCE: b5c6831e146e\nbody', fromNonce: true, source: 'x' });
    expect(fromNonceLine('lead-in\nNONCE: b5c6831e146e\nbody', 'b5c6831e146e', 'x')).toEqual({ text: 'lead-in\nNONCE: b5c6831e146e\nbody', fromNonce: false, source: 'x' });
    expect(fromNonceLine('NONCE: b5c6831e146e', 'not-a-nonce', 'x').fromNonce).toBe(false);
  });

  it('classifies a timed-out leg as timeout', () => {
    const { input } = inputFor('success', (dir) => {
      const leg = rolloutsOf(dir)[0] as string;
      writeJsonl(leg, readJsonl(leg).filter((row) => (row['payload'] as Record<string, unknown>)['type'] !== 'task_complete'));
      writeFileSync(join(dir, 'events.jsonl'), readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').slice(0, 4).join('\n'));
    });
    const r = ratifyCodexLeg({ ...input, timedOut: true });
    expect(r.failureClass).toBe('timeout');
  });
});

describe('codex native declaration (4.5, N28, N29)', () => {
  const decl = CODEX_DECLARED['0.167.0'];

  it('declares the 14 measured names verbatim, as the recorded rollout offers them', () => {
    const rollout = readJsonl(rolloutsOf(materialize('codex', 'success').dir)[0] as string);
    const offered = rollout.find((r) => r['type'] === 'world_state') as { payload: { state: { top_level_tools: string[] } } };
    expect(decl?.nativeOffer).toEqual(offered.payload.state.top_level_tools);
    expect(decl?.nativeOffer).toHaveLength(14);
  });

  it('maps every call name to a declared offer, and every leaf offer has a call', () => {
    const offers = new Set(Object.values(decl?.calls ?? {}).map((r) => r.offer));
    for (const offer of offers) expect(decl?.nativeOffer).toContain(offer);
    const leaves = (decl?.nativeOffer ?? []).filter((n) => n.includes('.'));
    expect([...offers].sort()).toEqual([...leaves].sort());
    expect(callRule(decl!, 'exec', null)).toEqual({ offer: 'functions.exec', class: 'command' });
    expect(callRule(decl!, 'spawn_agent', 'collaboration')).toEqual({ offer: 'collaboration.spawn_agent', class: 'spawn' });
    expect(callRule(decl!, 'sleep', null)).toEqual({ offer: 'clock.sleep', class: 'wait' });
    expect(callRule(decl!, 'spawn_agent', null)).toBeNull();
    expect(callRule(decl!, 'apply_patch', null)).toBeNull();
    expect(decl?.readCalls).toEqual([]);
  });
});

describe('codex exec scripts (N16)', () => {
  it('extracts cmd strings from object and string arguments, pragmas, comments and escapes', () => {
    const script = [
      '// @exec: {"yield_time_ms": 10000}',
      'text(await tools.exec_command({cmd:"pwd; rg --files -g \'calc/**\'",max_output_tokens:4000}));',
      '/* a comment with tools.exec_command("ignored") */',
      'const note = "tools are here";',
      'text(await tools.exec_command("nl -ba calc/a\\u002epy"));',
      "text(await tools.exec_command({'cmd': `ls -la`, \"yield_time_ms\": 1e3, flag: true}));",
    ].join('\n');
    const scan = scanExecInput(script);
    expect(scan).toEqual({
      ok: true,
      calls: [
        { tool: 'exec_command', cmd: "pwd; rg --files -g 'calc/**'", args: { cmd: "pwd; rg --files -g 'calc/**'", max_output_tokens: 4000 } },
        { tool: 'exec_command', cmd: 'nl -ba calc/a.py', args: { cmd: 'nl -ba calc/a.py' } },
        { tool: 'exec_command', cmd: 'ls -la', args: { cmd: 'ls -la', yield_time_ms: 1000, flag: true } },
      ],
    });
  });

  it.each([
    ['a computed command', 'const c = "cat"; await tools.exec_command({cmd: c + " x"});'],
    ['an interpolated template', 'await tools.exec_command({cmd: `cat ${f}`});'],
    ['tools passed around', 'const t = tools; await t.exec_command({cmd: "ls"});'],
    ['computed member access', 'await tools["exec_command"]({cmd: "ls"});'],
    ['an unterminated string', 'await tools.exec_command({cmd: "ls});'],
    ['a second cmd key', 'await tools.exec_command({cmd: "ls", cmd: "cat x"});'],
    ['ALL_TOOLS introspection (seen live)', 'text(ALL_TOOLS.map(x=>({name:x.name})));'],
    ['globalThis', 'await globalThis["to" + "ols"].exec_command({cmd: "ls"});'],
    ['a constructor escape', 'const g = [].constructor.constructor("return globalThis")();'],
    ['eval', 'eval("tools.exec_command({cmd: \'ls\'})");'],
  ])('fails closed on %s', (_what, script) => {
    expect(scanExecInput(script).ok).toBe(false);
  });

  // Round 1 (3/3): each of these hid a nested call from the scanner, which returned ok with no calls.
  it.each([
    ['a call inside a template expression', 'text(`${await tools.view_image({path: "/etc/hosts"})}`);', 'template literal with ${'],
    ['a template expression outside any call', 'const s = `${x}`; text(await tools.exec_command({cmd: "pwd"}));', 'template literal with ${'],
    ['tools spread into another object', 'const t = {...tools}; await t.view_image({path: "/etc/hosts"});', 'reached as a property'],
    ['tools read as a property', 'const t = x.tools; await t.view_image({path: "/etc/hosts"});', 'reached as a property'],
    ['tools read with optional chaining', 'await x?.tools.view_image({path: "/etc/hosts"});', 'reached as a property'],
    ['tools read as a property after a no-break space', 'await x.\u00a0tools.view_image({path: "/etc/hosts"});', 'reached as a property'],
    ['tools read as a property after a form feed', 'await x.\ftools.view_image({path: "/etc/hosts"});', 'reached as a property'],
    ['a regex literal that holds a comment opener', '/[/*]/.test(x); await tools.view_image({path: "/etc/hosts"});', 'regex literal'],
    ['a regex literal with an escaped slash', 'const r = /\\//; await tools.view_image({path: "/etc/hosts"});', 'regex literal'],
    ['a division', 'const half = n / 2; text(half);', 'division'],
    ['an escaped identifier', 'await \\u0074ools.view_image({path: "/etc/hosts"});', 'backslash outside a string'],
    ['the constructor chain through string keys', '[]["constructor"]["constructor"]("return this")().tools.view_image({path: "/etc/hosts"});', 'computed member access'],
    ['a computed key after a comment', 'g[/* key */ "x"];', 'computed member access'],
    ['a template key', 'g[`tools`].view_image({path: "/etc/hosts"});', 'computed member access'],
    ['a string that names a dynamic route', 'const k = "constructor"; text([][k][k]);', 'names constructor'],
    ['a template that names a dynamic route', 'const k = `Function`;', 'names Function'],
    ['a string that names the tools object', 'const k = "tools";', 'names tools'],
  ])('fails closed on %s (round 1)', (_what, script, reason) => {
    const scan = scanExecInput(script);
    expect(scan.ok).toBe(false);
    expect(scan.ok ? '' : scan.reason).toContain(reason);
  });

  it('ends a // comment at every JavaScript line terminator, so a call after U+2028 is read', () => {
    expect(scanExecInput('// note await tools.view_image({path: "/etc/hosts"});')).toEqual({
      ok: true,
      calls: [{ tool: 'view_image', cmd: null, args: { path: '/etc/hosts' } }],
    });
    expect(scanExecInput('// note tools.view_image({path: "/etc/hosts"});').ok).toBe(true);
  });

  it('accepts the shapes real council legs write: Promise.allSettled, an index key, a spread result, .output', () => {
    const script = [
      'const results = await Promise.allSettled([',
      '  tools.exec_command({cmd:"nl -ba a.md | sed -n \'1,200p\'","max_output_tokens":12000}),',
      '  tools.exec_command({cmd:"rg --files","max_output_tokens":4000})',
      ']); for (let i=0;i<results.length;i++) text({i,...results[i]});',
      'results.forEach((r,i)=>text({i,...r}));',
      'text((await tools.exec_command({cmd:"pwd"})).output);',
      'const note = `no interpolation here`;',
    ].join('\n');
    const scan = scanExecInput(script);
    expect(scan.ok).toBe(true);
    expect(scan.calls.map((c) => c.cmd)).toEqual(["nl -ba a.md | sed -n '1,200p'", 'rg --files', 'pwd']);
  });

  it('reads every nested call with its literal arguments, including list arguments and empty calls', () => {
    const scan = scanExecInput('text(await tools.clock__curr_time()); await tools.exec_command({cmd: "ls", prefix_rule: ["git", "pull"]});');
    expect(scan).toEqual({
      ok: true,
      calls: [
        { tool: 'clock__curr_time', cmd: null, args: {} },
        { tool: 'exec_command', cmd: 'ls', args: { cmd: 'ls', prefix_rule: ['git', 'pull'] } },
      ],
    });
  });
});

describe('codex nested exec tools (N18)', () => {
  /** The success leg with its second exec script replaced. */
  const withScript = (script: string) =>
    inputFor('success', (dir) => {
      const leg = rolloutsOf(dir)[0] as string;
      writeJsonl(
        leg,
        readJsonl(leg).map((row) => {
          const p = row['payload'] as Record<string, unknown>;
          if (p['type'] === 'custom_tool_call' && String(p['input']).includes('nl -ba calc/rangesum.py')) {
            p['input'] = script.replace('__CMD__', 'ls -la; nl -ba calc/rangesum.py; nl -ba calc/test_rangesum.py; nl -ba calc/__init__.py');
          }
          return row;
        }),
      );
    }).input;

  it('declares the eight nested tools the 0.167.0 exec description lists', () => {
    expect(Object.keys(CODEX_DECLARED['0.167.0']?.execNested ?? {}).sort()).toEqual(
      ['apply_patch', 'clock__curr_time', 'exec_command', 'list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource', 'view_image', 'write_stdin'],
    );
  });

  it.each([
    ['MCP listings and the clock (reads)', 'text(await tools.list_mcp_resources({})); text(await tools.clock__curr_time({})); text(await tools.exec_command({cmd: "__CMD__"}));'],
    ['view_image inside the root', 'text(await tools.view_image({path: "calc/plot.png"})); text(await tools.exec_command({cmd: "__CMD__"}));'],
    ['exec_command with declared harmless arguments', 'text(await tools.exec_command({cmd: "__CMD__", workdir: ".", login: false, tty: false, shell: "/bin/zsh", sandbox_permissions: "use_default"}));'],
  ])('allows %s', (_what, script) => {
    expect(ratifyCodexLeg(withScript(script)).status).toBe('PASS');
  });

  it.each([
    ['apply_patch (write-class)', 'await tools.apply_patch("*** Begin Patch"); text(await tools.exec_command({cmd: "__CMD__"}));', 'apply_patch'],
    ['write_stdin (bypasses the command parse)', 'await tools.write_stdin({session_id: 1, chars: "cat /etc/hosts"}); text(await tools.exec_command({cmd: "__CMD__"}));', 'write_stdin'],
    ['read_mcp_resource (MCP-class)', 'await tools.read_mcp_resource({server: "x", uri: "y"}); text(await tools.exec_command({cmd: "__CMD__"}));', 'read_mcp_resource'],
    ['an undeclared nested tool', 'await tools.web_fetch({url: "https://example.com"}); text(await tools.exec_command({cmd: "__CMD__"}));', 'undeclared nested tool web_fetch'],
    ['view_image outside the root', 'await tools.view_image({path: "/etc/x.png"}); text(await tools.exec_command({cmd: "__CMD__"}));', 'view_image path /etc/x.png'],
    ['view_image hidden in a template expression', 'text(`${await tools.view_image({path: "/etc/hosts"})}`); text(await tools.exec_command({cmd: "__CMD__"}));', 'template literal with ${'],
    ['an interpreter that builds an outside path', 'text(await tools.exec_command({cmd: "python3 -B -c \'print(open(\\"/\\"+\\"etc/hosts\\").read())\'"})); text(await tools.exec_command({cmd: "__CMD__"}));', 'python3 is not one of the read commands'],
    ['a read with a refused option', 'text(await tools.exec_command({cmd: "__CMD__; rg --pre cat x calc"}));', 'rg --pre is not an option rg may take'],
    ['view_image through a spread copy of tools', 'const t = {...tools}; await t.view_image({path: "/etc/hosts"}); text(await tools.exec_command({cmd: "__CMD__"}));', 'reached as a property'],
    ['an escalation request', 'text(await tools.exec_command({cmd: "__CMD__", sandbox_permissions: "require_escalated", justification: "x"}));', 'require_escalated'],
    ['a prefix rule', 'text(await tools.exec_command({cmd: "__CMD__", prefix_rule: ["ls"]}));', 'prefix_rule'],
    ['a workdir outside the root', 'text(await tools.exec_command({cmd: "__CMD__", workdir: "/etc"}));', 'workdir leaves the root'],
    ['another shell', 'text(await tools.exec_command({cmd: "__CMD__", shell: "/usr/bin/python3"}));', 'shell /usr/bin/python3'],
    ['an undeclared argument', 'text(await tools.exec_command({cmd: "__CMD__", env: "X=1"}));', 'undeclared argument(s) env'],
  ])('fails %s', (_what, script, detail) => {
    const r = ratifyCodexLeg(withScript(script));
    expect(r.status).toBe('CONTAMINATED');
    expect(failedNames(r)).toEqual(['commands']);
    expect(r.checks.find((c) => c.name === 'commands')?.detail).toContain(detail);
  });

  it('resolves relative paths in cmd against workdir, failing any climb after it (N17)', () => {
    const r = ratifyCodexLeg(withScript('text(await tools.exec_command({cmd: "__CMD__; cat ../x", workdir: "calc"}));'));
    expect(r.checks.find((c) => c.name === 'commands')?.detail).toContain('cd: ../x');
  });
});

describe('codex cmd paths (N17) and the read allowlist (round 1)', () => {
  const root = '/private/tmp/sc-root';
  const aliases = rootAliases(root);
  const kinds = (cmd: string): string[] => checkCommandPaths(cmd, root, aliases).map((p) => p.kind);

  it.each([
    ['pwd; rg --files -g AGENTS.md -g \'calc/**\' -g \'!**/node_modules/**\''],
    ['nl -ba calc/rangesum.py; wc -l notes/b.txt 2>/dev/null'],
    ['cat /private/tmp/sc-root/calc/x.py /tmp/sc-root/calc/y.py'],
    ['ls calc/*.py'],
    ['ls -a; find . -name AGENTS.md; cat PR.diff'],
    ["nl -ba docs/PLAN.md | sed -n '241,490p'"],
    ["rg -n -- '--restricted|symlink|^#{1,3} ' docs && head -n 5 a.md || tail -n 2 b.md"],
    ["rg -n 'round 3|^\\| [1-5]' PREVIOUS.md; wc -l a.md b.md"],
    ['find . -type f -name "*.py" -newer calc/x.py'],
    ["sed -n '1,20p;30p' a.md"],
    ["sed -E -e 's/a+/b/g' -e '/x/d' a.md"],
    ["sed -n '/^## Plan/,+5p' a.md"],
    ['diff -u a.md b.md >/dev/null 2>&1'],
    ['sort a.txt | uniq -c | sort -rn -k 1 | head'],
    ['cut -d, -f1 a.csv | tr a-z A-Z'],
    ['stat calc && file calc/x.py'],
    ['grep -rn x calc 2>/dev/null'],
    ['rg -nA3 -g "*.ts" x src'],
    ['pwd\nls -la\n\nnl -ba a.md'],
  ])('allows %s', (cmd) => {
    expect(checkCommandPaths(cmd, root, aliases)).toEqual([]);
  });

  it.each([
    // Paths and expansions (N17).
    ['cat /etc/hosts', 'outside-root'],
    ['cat ../secret.txt', 'outside-root'],
    ['nl -ba calc/../../x', 'outside-root'],
    ['cat ~/.ssh/id_rsa', 'home'],
    ['cat $HOME/.ssh/id_rsa', 'expansion'],
    ['cat "$HOME/x"', 'expansion'],
    ['cat $(echo /etc/hosts)', 'expansion'],
    ['cat `echo x`', 'expansion'],
    ['ls /etc/*', 'outside-root'],
    ['ls ../*', 'outside-root'],
    ['cat {../x,y}', 'expansion'],
    ['rg --files --hidden --glob=/etc/**', 'outside-root'],
    ["cat 'unbalanced", 'untokenizable'],
    ["cat $'\\x41'", 'untokenizable'],
    ['cat x\r', 'untokenizable'],
    ['cat =ls', 'expansion'],
    // Round 1 (2/3): reads a command line does not show.
    ['python3 -B -c \'print(open("/"+"etc/hosts").read())\'', 'command'],
    ["node -e \"require('fs').readFileSync('/'+'etc/hosts')\"", 'command'],
    ["bash -c 'cat ~/.ssh/id_rsa'", 'command'],
    ["bash -c 'cat ~/.ssh/id_rsa'", 'home'],
    ['cat "\\$HOME/.ssh/id_rsa"', 'expansion'],
    ["cat '~/.ssh/id_rsa'", 'home'],
    ['cat a~b', 'home'],
    ['python3 -c \'open("/Users/someone/.netrc")\'', 'outside-root'],
    // Everything that is not a read command.
    ['PYTHONDONTWRITEBYTECODE=1 python -m pytest -q calc', 'command'],
    ['PAGER=cat cat x', 'command'],
    ['/usr/bin/env python3 -V', 'command'],
    ['env cat x', 'command'],
    ['awk \'{print}\' calc/a.txt', 'command'],
    ['git log a..b', 'command'],
    ['xargs cat', 'command'],
    ['perl -e 1', 'command'],
    ['cd calc && nl -ba rangesum.py', 'command'],
    ['cd ..', 'command'],
    ['cd ~', 'home'],
    ['if [ -f BRIEF.md ]; then cat BRIEF.md; fi', 'command'],
    ['echo canary', 'command'],
    ['/bin/cat x', 'command'],
    ['constructor x', 'command'],
    // Redirects and shell syntax.
    ['cat x > out.txt', 'redirect'],
    ['cat x 2>err.log', 'redirect'],
    ['cat x >> /dev/null2', 'redirect'],
    ['cat < /etc/hosts', 'redirect'],
    ['cat <<EOF\nx\nEOF', 'redirect'],
    ['cat <<< x', 'redirect'],
    ['> /dev/null', 'syntax'],
    ['(cat x)', 'syntax'],
    ['cat x &', 'syntax'],
    ['diff <(cat a) b', 'syntax'],
    ['ls *(e:cat:)', 'syntax'],
    // Refused options.
    ['sed -i s/a/b/ x', 'option'],
    ['sed -ni s/a/b/ x', 'option'],
    ['sed --in-place=.bak s/a/b/ x', 'option'],
    ['sed -f script.sed x', 'option'],
    ["sed -n '1w out.txt' x", 'option'],
    ["sed 's/a/b/w out.txt' x", 'option'],
    ["sed 's/a/b/e' x", 'option'],
    ["sed '1e id' x", 'option'],
    ["sed 'r /etc/hosts' x", 'option'],
    ['sed R x', 'option'],
    ['sed W x', 'option'],
    ["sed -n 's/[/]/x/w out' x", 'option'],
    ["sed -e p -e 'w out' x", 'option'],
    ['sed', 'option'],
    ["sed -n '/x/p' /etc/hosts", 'outside-root'],
    ["sed -e '$p' x", 'expansion'],
    ['rg --pre cat x', 'option'],
    ['rg --pre=cat x', 'option'],
    ["rg --pre-glob '*' x", 'option'],
    ['rg -z x', 'option'],
    ['rg -nz x', 'option'],
    ['rg --search-zip x', 'option'],
    ['rg --hostname-bin=cat x', 'option'],
    ['find . -exec cat {} +', 'option'],
    ['find . -execdir cat {} +', 'option'],
    ['find . -ok cat {} ;', 'option'],
    ['find . -okdir cat {} ;', 'option'],
    ['find . -delete', 'option'],
    ['find . -fprint out', 'option'],
    ['find . -fls out', 'option'],
    ['sort -o out a', 'option'],
    ['sort --compress-program=cat a', 'option'],
    ['sort --files0-from=list', 'option'],
    ['wc --files0-from=list', 'option'],
    ['uniq a out', 'option'],
    ['file -f list', 'option'],
  ])('fails %j (%s)', (cmd, kind) => {
    expect(kinds(cmd)).toContain(kind);
  });

  /** A harmless invocation of one option, so each declared option can be shown to pass. */
  const SAMPLE: Readonly<Record<string, string>> = { path: 'calc', number: '3', text: 'x', script: 'p' };
  const invoke = (name: string, option: string): string =>
    name === 'sed' ? `sed ${option} -e p calc` : name === 'find' ? `find calc ${option}` : `${name} ${option} calc`;

  it('passes every option each command declares, in every spelling, and nothing the declaration leaves out (no drift)', () => {
    for (const [name, rule] of Object.entries(READ_COMMANDS)) {
      const cases: string[] = [name === 'sed' ? 'sed -n 1p calc' : `${name} calc`];
      for (const flag of rule.flags) cases.push(name === 'find' ? `find -${flag} calc` : invoke(name, `-${flag}`));
      for (const [flag, kind] of Object.entries(rule.values ?? {})) {
        cases.push(invoke(name, `-${flag} ${SAMPLE[kind] ?? ''}`), invoke(name, `-${flag}${SAMPLE[kind] ?? ''}`));
      }
      for (const [long, kind] of Object.entries(rule.long ?? {})) {
        if (kind === null) cases.push(invoke(name, long));
        else cases.push(invoke(name, `${long}=${SAMPLE[kind] ?? ''}`), invoke(name, `${long} ${SAMPLE[kind] ?? ''}`));
        // A unique prefix is what getopt_long accepts; the declaration never does.
        const prefix = long.slice(0, -1);
        if (!Object.hasOwn(rule.long ?? {}, prefix)) expect(kinds(invoke(name, prefix)), `${name} ${prefix}`).toContain('option');
      }
      for (const [predicate, kind] of Object.entries(rule.predicates ?? {})) cases.push(`find calc ${predicate}${kind === null ? '' : ` ${SAMPLE[kind] ?? ''}`}`);
      if (rule.countOption) cases.push(`${name} -5 calc`);
      for (const cmd of cases) expect(checkCommandPaths(cmd, root, aliases), cmd).toEqual([]);
      for (const option of rule.never) {
        const cmd = name === 'find' ? `find . ${option} x` : `${name} ${option} x calc`;
        expect(kinds(cmd), cmd).toContain('option');
        expect(CODEX_READ_PREFACE).toContain(option);
      }
      expect(CODEX_READ_PREFACE).toContain(readCommandUsage(name));
      if (rule.also !== undefined) expect(CODEX_READ_PREFACE).toContain(rule.also);
    }
    expect(READ_COMMAND_NAMES).toEqual(['rg', 'grep', 'sed', 'nl', 'cat', 'head', 'tail', 'wc', 'ls', 'pwd', 'find', 'diff', 'sort', 'uniq', 'cut', 'tr', 'stat', 'file']);
  });

  // Round 2 (3/3, reproduced on dist): options the refused-list design let through.
  it.each([
    // An attached path value was never path-checked; every spelling is now.
    ['rg -F -f/etc/hosts README.md', 'outside-root'],
    ['rg -nf/etc/hosts README.md', 'outside-root'],
    ['rg -f /etc/hosts README.md', 'outside-root'],
    ['rg --file=/etc/hosts README.md', 'outside-root'],
    ['rg --file /etc/hosts README.md', 'outside-root'],
    ['rg -f../x README.md', 'outside-root'],
    ['rg --file=../x README.md', 'outside-root'],
    ['grep --file ../x README.md', 'outside-root'],
    ['grep -f/etc/hosts README.md', 'outside-root'],
    ['grep -vf/etc/hosts README.md', 'outside-root'],
    ['grep --file=/etc/hosts README.md', 'outside-root'],
    ['diff -X/etc/hosts a b', 'outside-root'],
    ['find . -newer /etc/hosts', 'outside-root'],
    ['rg -f~/x README.md', 'home'],
    // A unique prefix of a long option is what getopt_long accepts.
    ['sort -S 1 --compress=python3 a.txt', 'option'],
    ['sort --compress=cat a.txt', 'option'],
    ['sort --out=x a.txt', 'option'],
    ['wc --files0=list.txt', 'option'],
    ['rg --hidd x', 'option'],
    ['grep --line-num x a.txt', 'option'],
    // Modes nobody declared.
    ['file -m/etc/hosts README', 'option'],
    ['file -C -m rules.magic', 'option'],
    ['file --compile rules.magic', 'option'],
    ['sort -T /tmp a.txt', 'option'],
    ['sort -S 1 a.txt', 'option'],
    ['find -L . -name x', 'option'],
    ['rg -L x', 'option'],
    ['grep -R x .', 'option'],
    ['tail -f a.txt', 'option'],
    ['ls -L', 'option'],
    ['stat -L a', 'option'],
    // Values are checked by kind.
    ['head -n x a.txt', 'option'],
    ['rg --max-count=x y a', 'option'],
    ['find . -maxdepth x', 'option'],
    ['rg --files=x', 'option'],
    ['rg -A', 'option'],
  ])('fails %j (%s) (round 2)', (cmd, kind) => {
    expect(kinds(cmd)).toContain(kind);
  });

  it.each([
    ["rg -n --max-count 12 'x' docs"],
    ['rg --max-count=12 -C3 -g\'!**/.git/**\' x docs'],
    ['rg -f calc/pats.txt docs'],
    ['grep -f calc/pats.txt -- -x docs'],
    ['head -20 a.md; tail -n +5 a.md; head -c 1K a.md'],
    ['find . -maxdepth 2 -type f -name "*.md" -print'],
    ['sed -n -e 1p -e 2p a.md; sed --expression=1p a.md'],
    ['nl -ba -w3 a.md'],
  ])('allows %j (round 2)', (cmd) => {
    expect(checkCommandPaths(cmd, root, aliases)).toEqual([]);
  });

  it('reports a path value written as its own word once, not twice', () => {
    expect(checkCommandPaths('rg -f /etc/hosts README.md', root, aliases)).toHaveLength(1);
  });

  it.each([
    ['1,200p', null],
    ['$p', null],
    ['/a/,/b/{p;n}', null],
    ['s/x/y/gp;y/ab/ba/', null],
    ['10q;l 5;=', null],
    ['1w out', 'the w command'],
    ['s/a/b/w out', 's///w flag'],
    ['s/a/b/e', 's///e flag'],
    ['e date', 'the e command'],
    ['a text', 'the a command'],
    ['b end', 'the b command'],
    ['\\|a|p', 'custom delimiter'],
    ['/[w]/p', 'bracket expression'],
    ['{p', 'unclosed {'],
    ['1,', 'a range with no end'],
    ['p x', 'text after the p command'],
  ])('reads the sed script %j as %j', (script, problem) => {
    const got = sedScriptProblem(script);
    if (problem === null) expect(got).toBeNull();
    else expect(got).toContain(problem);
  });

  it('realpaths every existing token: a link in the root that points out fails, a file in the root passes', () => {
    const real = scratch('sc-cmd-root-');
    const outside = scratch('sc-cmd-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'x');
    mkdirSync(join(real, 'calc'));
    writeFileSync(join(real, 'calc', 'x.py'), 'x');
    symlinkSync(join(outside, 'secret.txt'), join(real, 'link.txt'));
    symlinkSync(outside, join(real, 'out-dir'));
    const realAliases = rootAliases(real);
    expect(checkCommandPaths('cat calc/x.py; ls calc', real, realAliases)).toEqual([]);
    expect(checkCommandPaths('cat link.txt', real, realAliases).map((p) => p.kind)).toEqual(['outside-root']);
    expect(checkCommandPaths('rg -n x out-dir', real, realAliases).map((p) => p.kind)).toEqual(['outside-root']);
    expect(checkCommandPaths(`cat ${join(real, 'link.txt')}`, real, realAliases).map((p) => p.kind)).toEqual(['outside-root']);
  });
});

describe('codex failure classifier (4.4)', () => {
  it.each([
    ['You’ve hit your usage limit. Upgrade to Pro or try again at 4:32 PM.', 'usage_limit'],
    ["You've hit your usage limit for gpt-6.1-sol. Switch to another model now.", 'usage_limit'],
    ['Quota exceeded. Check your plan and billing details.', 'usage_limit'],
    ['Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.', 'auth'],
    ['unexpected status 401 Unauthorized: {"error":"invalid"}', 'auth'],
    ['Selected model is at capacity. Please try a different model.', 'capacity'],
    ['rate limit exceeded: try later', 'capacity'],
    ['model rerouted: gpt-6.1-sol -> gpt-6-luna (high demand)', 'model'],
    ['stream disconnected before completion', 'transport'],
    ['Not inside a trusted directory and --skip-git-repo-check was not specified.', 'setup'],
    ['Reading additional input from stdin...', 'setup'],
  ])('%s -> %s', (text, cls) => {
    expect(classifyCodexText([text])).toBe(cls);
  });

  it('returns null for ordinary stderr', () => {
    expect(classifyCodexText(['', 'warning: something harmless'])).toBeNull();
  });
});

const FAKE_CODEX = new URL('./fixtures/bin/fake-codex.mjs', import.meta.url).pathname;

function fakeHome(config: Record<string, unknown>): { home: string; env: NodeJS.ProcessEnv } {
  const home = scratch('sc-fake-codex-');
  writeFileSync(
    join(home, 'fake-codex.json'),
    JSON.stringify({ promptInput: join(fixtureDir('codex', 'prompt-input'), 'clean.json'), mcp: ['docs-server', 'cloud_admin'], ...config }),
  );
  mkdirSync(join(home, '.codex'));
  return { home, env: { PATH: process.env['PATH'], HOME: home, CODEX_HOME: join(home, '.codex'), SECRET_TOKEN: 'never-forwarded' } };
}

const OCC: Occupant = { backend: 'codex', model: 'gpt-6.1-sol', effort: 'low' };

describe('codex preflight (4.3), through a fake CLI', () => {
  const pre = (config: Record<string, unknown>, o: Occupant = OCC) => {
    const { home, env } = fakeHome(config);
    const root = scratch('sc-pre-root-');
    return { home, run: codexPreflight(o, { bin: FAKE_CODEX, runner: runCommand, env, root }) };
  };

  it('passes, disables every MCP server by name, and lists the global AGENTS.md as user-owned', async () => {
    const { home, run } = pre({});
    const p = await run;
    expect(p.ok).toBe(true);
    expect(p.enforcement).toBe('sandboxed-exec');
    expect(p.checks.map((c) => `${c.status} ${c.name}`)).toEqual(['ok version', 'ok auth', 'ok model', 'ok mcp', 'ok isolation', 'note user-owned']);
    expect(p.userOwned[0]).toContain('global AGENTS.md');
    expect(p.data['mcpNames']).toEqual(['docs-server', 'cloud_admin']);
    const argv = JSON.parse(readFileSync(join(home, 'prompt-input-argv.json'), 'utf8')) as { args: string[] };
    expect(argv.args).toContain('mcp_servers.docs-server.enabled=false');
    expect(argv.args).toContain('mcp_servers.cloud_admin.enabled=false');
    expect(argv.args).not.toContain('--ignore-user-config');
  });

  it.each([
    [{ loggedIn: false }, 'auth', 'auth'],
    [{ models: ['gpt-6-luna'] }, 'model', 'model'],
    [{ version: '0.168.0' }, 'setup', 'version'],
    [{ mcp: ['bad.name'] }, 'setup', 'mcp'],
    [{ promptInput: join(fixtureDir('codex', 'prompt-input'), 'mcp-server.json') }, 'setup', 'isolation'],
    [{ promptInput: join(fixtureDir('codex', 'prompt-input'), 'repo-agents-md.json') }, 'setup', 'isolation'],
    [{ promptInput: join(fixtureDir('codex', 'prompt-input'), 'nested-undeclared.json') }, 'setup', 'isolation'],
  ])('refuses %j', async (config, cls, check) => {
    const p = await pre(config).run;
    expect(p.ok).toBe(false);
    expect(p.failureClass).toBe(cls);
    expect(p.checks.find((c) => c.status === 'fail')?.name).toBe(check);
  });

  it('reports what the render loads from the root, for doctor --deep', async () => {
    const p = await pre({ promptInput: join(fixtureDir('codex', 'prompt-input'), 'repo-agents-md.json') }).run;
    expect(p.data['loaded']).toEqual(['repository AGENTS.md instructions']);
    const clean = await pre({}).run;
    expect(clean.data['loaded']).toBeUndefined();
  });

  it('refuses a seat with no effort', async () => {
    const p = await pre({}, { backend: 'codex', model: 'gpt-6.1-sol' }).run;
    expect(p).toMatchObject({ ok: false, failureClass: 'setup' });
  });

  it('judges a prompt-input render', () => {
    const decl = CODEX_DECLARED['0.167.0']!;
    const load = (n: string): unknown => JSON.parse(readFileSync(join(fixtureDir('codex', 'prompt-input'), n), 'utf8'));
    const nested = Object.keys(decl.execNested);
    expect(judgePromptInput(load('clean.json'), decl.nativeOffer, nested)).toMatchObject({ undeclared: [], undeclaredNested: [], mcpTools: [], deferredNamespaces: false, repoInstructions: false, globalAgentsMd: true });
    expect(judgePromptInput(load('clean.json'), decl.nativeOffer, nested).nested).toHaveLength(8);
    expect(judgePromptInput(load('nested-undeclared.json'), decl.nativeOffer, nested).undeclaredNested).toEqual(['web_fetch']);
    expect(judgePromptInput(load('mcp-server.json'), decl.nativeOffer)).toMatchObject({ mcpTools: ['mcp__example', 'mcp__example.run_query'], deferredNamespaces: true });
    expect(judgePromptInput(load('repo-agents-md.json'), decl.nativeOffer).repoInstructions).toBe(true);
  });
});

describe('codex launch', () => {
  it('builds the exact command line from the brief, prompt on stdin', () => {
    expect(codexExecArgs({ root: '/r', model: 'gpt-6.1-sol', effort: 'high', mcpNames: ['a', 'b-c'], lastFile: '/l/last.txt' })).toEqual([
      'exec', '--json', '--color', 'never', '-C', '/r', '--skip-git-repo-check', '-s', 'read-only', '-m', 'gpt-6.1-sol',
      '-c', 'model_reasoning_effort="high"', '--disable', 'apps', '--disable', 'plugins', '--disable', 'hooks', '--disable', 'multi_agent',
      '-c', 'project_doc_max_bytes=0', '-c', 'skills.include_instructions=false', '-c', 'web_search="disabled"',
      '-c', 'analytics.enabled=false', '-c', 'check_for_update_on_startup=false',
      '-c', 'mcp_servers.a.enabled=false', '-c', 'mcp_servers.b-c.enabled=false',
      '-o', '/l/last.txt', '-',
    ]);
  });

  it('runs a leg end to end: preflight, launch, record-based done, collect from the nonce, ratify', async () => {
    // The fake fills in the placeholders itself, with the root it is given.
    const { home, env } = fakeHome({ fixture: fixtureDir('codex', 'success') });
    const root = scratch('sc-e2e-root-');
    const legDir = scratch('sc-e2e-leg-');
    const briefFile = join(legDir, 'BRIEF.md');
    writeFileSync(briefFile, 'NONCE: b5c6831e146e\nreview calc/\n');
    const adapter = createCodexAdapter({ bin: FAKE_CODEX });
    const ctx: RoundCtx = { root, legDir, nonce: 'b5c6831e146e', briefFile, timeoutMs: 30_000, env, rootUnchanged: () => ({ unchanged: true, changes: [] }) };
    const handle = await adapter.launch(OCC, ctx);
    let state = await adapter.poll(handle);
    while (state.status === 'running') {
      await new Promise((r) => setTimeout(r, 50));
      state = await adapter.poll(handle);
    }
    expect(state).toMatchObject({ status: 'done', doneBy: 'record' });
    const text = await adapter.collect(handle);
    expect(text.fromNonce).toBe(true);
    expect(text.text?.startsWith('NONCE: b5c6831e146e')).toBe(true);
    const r = await adapter.ratify(handle, ctx);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.status).toBe('PASS');
    expect(adapter.classify(handle)).toBeNull();
    // The CLI saw the brief on stdin, cwd = root, and a scrubbed environment.
    const argv = JSON.parse(readFileSync(join(home, 'exec-argv.json'), 'utf8')) as { args: string[]; cwd: string; env: string[] };
    const stdin = readFileSync(join(home, 'exec-stdin.txt'), 'utf8');
    expect(stdin.startsWith(CODEX_READ_PREFACE)).toBe(true);
    expect(stdin.slice(CODEX_READ_PREFACE.length)).toBe(readFileSync(ctx.briefFile, 'utf8'));
    expect(stdin).toContain('NONCE: b5c6831e146e');
    expect(argv.cwd).toBe(root);
    expect(argv.args.at(-1)).toBe('-');
    for (const name of argv.env) expect([...CODEX_ENV_ALLOW, 'NO_COLOR', '__CF_USER_TEXT_ENCODING']).toContain(name);
    expect(argv.env).not.toContain('SECRET_TOKEN');
    const record = JSON.parse(readFileSync(join(legDir, 'process.json'), 'utf8')) as { env_names: string[]; exit: { doneBy: string } };
    expect(record.env_names).not.toContain('SECRET_TOKEN');
    expect(record.exit.doneBy).toBe('record');
  });
});
