import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Text-level checks over supabase/migrations/*.sql — nothing here connects to
// a database. SQL comments are stripped before matching so prose like
// "no insert policy" can't satisfy or trip a check.

const DIR = path.resolve(__dirname, '../../supabase/migrations');
const files = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

const sources = files.map((name) => ({
  name,
  sql: stripComments(fs.readFileSync(path.join(DIR, name), 'utf8')).toLowerCase(),
}));
const allSql = sources.map((s) => s.sql).join('\n');

function sourceOf(name: string) {
  const found = sources.find((s) => s.name === name);
  if (!found) throw new Error(`missing migration ${name}`);
  return found.sql;
}

describe('migration filenames', () => {
  it('finds migrations to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(39);
  });

  it('are all NNNN_snake_case.sql', () => {
    for (const f of files) expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
  });

  it('are numbered sequentially from 0001 with no gaps or duplicates', () => {
    const numbers = files.map((f) => Number(f.slice(0, 4)));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });
});

describe('row level security', () => {
  const created = Array.from(
    allSql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?("?[a-z0-9_]+"?)(?:\s*\.\s*("?[a-z0-9_]+"?))?/g)
  )
    .filter((m) => !m[2]) // schema-qualified non-public tables (m[2] set) are skipped below
    .map((m) => m[1].replace(/"/g, ''));

  // Tables explicitly created in another schema, e.g. auth.foo — none expected.
  const otherSchema = Array.from(allSql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_]+)\.([a-z0-9_]+)/g))
    .filter((m) => m[1] !== 'public')
    .map((m) => `${m[1]}.${m[2]}`);

  it('finds the public tables', () => {
    expect(created).toEqual(expect.arrayContaining(['user_roles', 'pathways', 'rate_limits', 'sys_errors', 'ai_usage']));
    expect(otherSchema).toEqual([]);
  });

  it('every public table created has RLS enabled somewhere', () => {
    const missing = [...new Set(created)].filter(
      (t) => !new RegExp(`alter\\s+table\\s+(?:public\\.)?${t}\\s+enable\\s+row\\s+level\\s+security`).test(allSql)
    );
    expect(missing).toEqual([]);
  });

  it('no migration disables RLS', () => {
    expect(allSql).not.toMatch(/disable\s+row\s+level\s+security/);
  });
});

describe('0039_default_adopter_role', () => {
  const sql = sourceOf('0039_default_adopter_role.sql');

  it('defines grant_default_adopter_role as security definer with an empty search_path', () => {
    const fn = sql.match(/create\s+or\s+replace\s+function\s+public\.grant_default_adopter_role\(\)[\s\S]*?\$\$;/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toMatch(/returns\s+trigger/);
    expect(fn![0]).toMatch(/security\s+definer/);
    expect(fn![0]).toMatch(/set\s+search_path\s*=\s*''/);
    expect(fn![0]).toMatch(/insert\s+into\s+public\.user_roles\s*\(user_id,\s*role\)\s*values\s*\(new\.id,\s*'adopter'\)/);
    expect(fn![0]).toMatch(/on\s+conflict\s*\(user_id,\s*role\)\s+do\s+nothing/);
  });

  it('creates the on_auth_user_created_grant_adopter trigger after insert on auth.users', () => {
    expect(sql).toMatch(/drop\s+trigger\s+if\s+exists\s+on_auth_user_created_grant_adopter\s+on\s+auth\.users/);
    expect(sql).toMatch(
      /create\s+trigger\s+on_auth_user_created_grant_adopter\s+after\s+insert\s+on\s+auth\.users\s+for\s+each\s+row\s+execute\s+function\s+public\.grant_default_adopter_role\(\)/
    );
  });

  it('backfills adopter for every existing auth user idempotently', () => {
    expect(sql).toMatch(
      /insert\s+into\s+public\.user_roles\s*\(user_id,\s*role\)\s*select\s+id,\s*'adopter'\s+from\s+auth\.users\s+on\s+conflict\s*\(user_id,\s*role\)\s+do\s+nothing/
    );
  });

  it('removes general_user rows before tightening the check', () => {
    const del = sql.search(/delete\s+from\s+public\.user_roles\s+where\s+role\s*=\s*'general_user'/);
    const add = sql.search(/add\s+constraint\s+user_roles_role_check/);
    expect(del).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(del);
  });
});

describe('user_roles role check', () => {
  it('the last definition allows exactly adopter, pathway_contributor and admin', () => {
    const defs = Array.from(
      allSql.matchAll(/add\s+constraint\s+user_roles_role_check\s+check\s*\(\s*role\s+in\s*\(([^)]*)\)\s*\)/g)
    );
    expect(defs.length).toBeGreaterThan(0);
    const last = defs[defs.length - 1][1];
    const roles = Array.from(last.matchAll(/'([a-z_]+)'/g)).map((m) => m[1]).sort();
    expect(roles).toEqual(['admin', 'adopter', 'pathway_contributor']);
    expect(roles).not.toContain('general_user');
  });

  it('the last check is defined in 0039', () => {
    const lastFile = [...sources].reverse().find((s) => /add\s+constraint\s+user_roles_role_check/.test(s.sql));
    expect(lastFile?.name).toBe('0039_default_adopter_role.sql');
  });
});

describe('user_roles cannot be written by clients', () => {
  const policies = Array.from(
    allSql.matchAll(/create\s+policy\s+"[^"]*"\s+on\s+(?:public\.)?user_roles\b([\s\S]*?);/g)
  ).map((m) => m[1]);

  it('has a read-own-roles select policy', () => {
    expect(policies.some((p) => /for\s+select/.test(p) && /auth\.uid\(\)\s*=\s*user_id/.test(p))).toBe(true);
  });

  it('defines no insert/update/delete/all policy on user_roles', () => {
    const writable = policies.filter((p) => /for\s+(insert|update|delete|all)\b/.test(p) || !/for\s+select/.test(p));
    expect(writable).toEqual([]);
  });

  it('grants no write privilege on user_roles to anon/authenticated/public', () => {
    expect(allSql).not.toMatch(
      /grant\s+[^;]*\b(insert|update|delete|all)\b[^;]*\bon\s+(?:table\s+)?(?:public\.)?user_roles\b[^;]*\bto\s+[^;]*\b(anon|authenticated|public)\b/
    );
  });
});

// pathways.content_cache is a pathway's unpublished, under-review document, so
// no policy left standing may let any signed-in user read every row.
describe('pathways select policies (0040)', () => {
  // Policies on pathways left after every migration: created ones minus those
  // a later migration drops by name.
  function effectivePolicies() {
    const live = new Map<string, string>();
    for (const { sql } of sources) {
      for (const m of sql.matchAll(
        /(create|drop)\s+policy\s+(?:if\s+exists\s+)?"([^"]+)"\s+on\s+(?:public\.)?pathways\b([\s\S]*?);/g
      )) {
        if (m[1] === 'create') live.set(m[2], m[3]);
        else live.delete(m[2]);
      }
    }
    return live;
  }

  it('drops the 0020 "any signed-in user" select policy', () => {
    expect(effectivePolicies().has('signed-in users can view pathways')).toBe(false);
  });

  it('no remaining select policy is satisfied by being signed in alone', () => {
    const selects = [...effectivePolicies().values()].filter((p) => /for\s+select/.test(p));
    expect(selects.length).toBeGreaterThan(0);
    for (const p of selects) {
      expect(p).not.toMatch(/using\s*\(\s*auth\.uid\(\)\s+is\s+not\s+null\s*\)/);
      expect(p).not.toMatch(/using\s*\(\s*true\s*\)/);
    }
  });

  it('admits exactly members of the pathway and admin role holders', () => {
    const [policy] = [...effectivePolicies().values()].filter((p) => /for\s+select/.test(p));
    expect(policy).toMatch(/pathway_contributors\s+pc\s+where\s+pc\.pathway_id\s*=\s*pathways\.id\s+and\s+pc\.user_id\s*=\s*auth\.uid\(\)/);
    expect(policy).toMatch(/user_roles\s+ur\s+where\s+ur\.user_id\s*=\s*auth\.uid\(\)\s+and\s+ur\.role\s*=\s*'admin'/);
  });
});

// The brain snapshot carries contributor-only Source Trace appendices, and the
// selection cache is per-design server state: neither is for browser clients.
describe('0042_brain_knowledge_source', () => {
  const sql = sourceOf('0042_brain_knowledge_source.sql');

  it('creates both tables with RLS on and no policies', () => {
    for (const table of ['brain_snapshots', 'knowledge_selections']) {
      expect(sql).toMatch(new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}\\b`));
      expect(sql).toMatch(new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`));
      expect(allSql).not.toMatch(new RegExp(`create\\s+policy[^;]*\\bon\\s+(?:public\\.)?${table}\\b`));
    }
  });

  it('cascades a design deletion to its cached selection', () => {
    expect(sql).toMatch(/design_id\s+uuid\s+primary\s+key\s+references\s+public\.designs\s*\(id\)\s+on\s+delete\s+cascade/);
  });

  it('adds the PR columns to pathways with constrained states', () => {
    expect(sql).toMatch(/brain_pr_state\s+text\s+check\s*\(brain_pr_state\s+in\s*\('open',\s*'merged',\s*'closed'\)\)/);
    expect(sql).toMatch(/brain_validation\s+text\s+check\s*\(brain_validation\s+in\s*\('pending',\s*'passed',\s*'failed'\)\)/);
  });

  it('is additive only', () => {
    expect(sql).not.toMatch(/\bdrop\s+(table|column|policy|function)\b/);
    expect(sql).not.toMatch(/\brename\b/);
  });
});
