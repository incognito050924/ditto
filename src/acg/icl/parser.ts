/**
 * ICL parser — tokens → AST (30 §2 EBNF).
 *
 * Per scope boundary (D6) this is a single-pass recursive-descent parser with NO
 * error recovery: the first malformed token raises IclParseError and parsing
 * stops. That is sufficient — full-EBNF recovery is out of scope.
 *
 * `meta rationale` is parsed and retained on the AST; compile.ts drops it (§3).
 */

import type {
  IclAcceptance,
  IclCadence,
  IclCheck,
  IclEvidenceKind,
  IclFitness,
  IclFitnessKind,
  IclFrequency,
  IclIntent,
  IclInvariant,
  IclMeta,
  IclProgram,
  IclRiskLevel,
  IclScopeKind,
  IclScopeRef,
  IclViolationAction,
} from './ast';
import { type IclToken, tokenize } from './tokenizer';

export class IclParseError extends Error {
  constructor(
    message: string,
    public readonly line?: number,
  ) {
    super(message);
    this.name = 'IclParseError';
  }
}

const SCOPE_KINDS: ReadonlySet<string> = new Set(['path', 'glob', 'symbol', 'surface', 'layer']);
const EVIDENCE_KINDS: ReadonlySet<string> = new Set([
  'test',
  'build',
  'log',
  'diff',
  'screen',
  'manual',
  'e2e',
]);
const FITNESS_KINDS: ReadonlySet<string> = new Set([
  'architectural',
  'dependency',
  'semantic',
  'coverage',
  'consistency',
  'performance',
  'duplication',
  'complexity',
  'user_journey',
]);
const RISK_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);
const FREQUENCIES: ReadonlySet<string> = new Set(['daily', 'weekly', 'on_release']);
const VIOLATION_ACTIONS: ReadonlySet<string> = new Set(['block', 'warn', 'track']);

class Parser {
  private pos = 0;

  constructor(private readonly tokens: IclToken[]) {}

  private peek(): IclToken | undefined {
    return this.tokens[this.pos];
  }

  private next(): IclToken {
    const tok = this.tokens[this.pos];
    if (!tok) {
      throw new IclParseError('unexpected end of input');
    }
    this.pos += 1;
    return tok;
  }

  private expectIdent(value: string): IclToken {
    const tok = this.next();
    if (tok.type !== 'ident' || tok.value !== value) {
      throw new IclParseError(`expected '${value}', got '${tok.value}'`, tok.line);
    }
    return tok;
  }

  private expectPunct(value: string): IclToken {
    const tok = this.next();
    if (tok.type !== 'punct' || tok.value !== value) {
      throw new IclParseError(`expected '${value}', got '${tok.value}'`, tok.line);
    }
    return tok;
  }

  private expectString(what: string): string {
    const tok = this.next();
    if (tok.type !== 'string') {
      throw new IclParseError(`expected string for ${what}, got '${tok.value}'`, tok.line);
    }
    return tok.value;
  }

  private isIdent(value: string): boolean {
    const tok = this.peek();
    return tok !== undefined && tok.type === 'ident' && tok.value === value;
  }

  private isPunct(value: string): boolean {
    const tok = this.peek();
    return tok !== undefined && tok.type === 'punct' && tok.value === value;
  }

  parseProgram(): IclProgram {
    const { title, intent } = this.parseIntentBlock();
    const fitness: IclFitness[] = [];
    while (this.isIdent('fitness')) {
      fitness.push(this.parseFitnessBlock());
    }
    const trailing = this.peek();
    if (trailing) {
      throw new IclParseError(`unexpected token '${trailing.value}' after program`, trailing.line);
    }
    return { intentTitle: title, intent, fitness };
  }

  private parseIntentBlock(): { title: string; intent: IclIntent } {
    this.expectIdent('intent');
    const title = this.expectString('intent title');
    this.expectPunct('{');

    this.expectIdent('purpose');
    this.expectPunct(':');
    const purpose = this.expectString('purpose');

    const { allow, forbid } = this.parseScopeSection();

    const invariants = this.isIdent('invariant') ? this.parseInvariantSection() : [];
    const acceptance = this.parseAcceptanceSection();
    const meta = this.isIdent('meta') ? this.parseMetaSection() : {};

    this.expectPunct('}');
    return { title, intent: { purpose, allow, forbid, invariants, acceptance, meta } };
  }

  private parseScopeSection(): { allow: IclScopeRef[]; forbid: IclScopeRef[] } {
    this.expectIdent('allow');
    this.expectPunct('{');
    const allow: IclScopeRef[] = [];
    while (!this.isPunct('}')) {
      allow.push(this.parseScopeRef());
    }
    this.expectPunct('}');

    this.expectIdent('forbid');
    this.expectPunct('{');
    const forbid: IclScopeRef[] = [];
    while (!this.isPunct('}')) {
      forbid.push(this.parseScopeRef());
    }
    this.expectPunct('}');

    return { allow, forbid };
  }

  private parseScopeRef(): IclScopeRef {
    const kindTok = this.next();
    if (kindTok.type !== 'ident' || !SCOPE_KINDS.has(kindTok.value)) {
      throw new IclParseError(`expected scope kind, got '${kindTok.value}'`, kindTok.line);
    }
    const ref = this.expectString('scope reference');
    const scope: IclScopeRef = {
      kind: kindTok.value as IclScopeKind,
      ref,
      line: kindTok.line,
    };
    if (this.isIdent('as')) {
      this.next();
      scope.alias = this.expectString('scope alias');
    }
    const noteTok = this.peek();
    if (noteTok && noteTok.type === 'note') {
      this.next();
      scope.note = noteTok.value;
    }
    return scope;
  }

  private parseInvariantSection(): IclInvariant[] {
    this.expectIdent('invariant');
    this.expectPunct('{');
    const invariants: IclInvariant[] = [];
    while (!this.isPunct('}')) {
      const statement = this.expectString('invariant statement');
      let promote = false;
      if (this.isIdent('promote')) {
        this.next();
        promote = true;
      }
      invariants.push({ statement, promote });
    }
    this.expectPunct('}');
    return invariants;
  }

  private parseAcceptanceSection(): IclAcceptance[] {
    this.expectIdent('accept');
    this.expectPunct('{');
    const acceptance: IclAcceptance[] = [];
    while (!this.isPunct('}')) {
      const criterion = this.expectString('acceptance criterion');
      this.expectIdent('by');
      const evTok = this.next();
      if (evTok.type !== 'ident' || !EVIDENCE_KINDS.has(evTok.value)) {
        throw new IclParseError(`expected evidence kind, got '${evTok.value}'`, evTok.line);
      }
      acceptance.push({ criterion, evidence: evTok.value as IclEvidenceKind });
    }
    this.expectPunct('}');
    return acceptance;
  }

  private parseMetaSection(): IclMeta {
    this.expectIdent('meta');
    this.expectPunct('{');
    const meta: IclMeta = {};
    while (!this.isPunct('}')) {
      const keyTok = this.next();
      if (keyTok.type !== 'ident') {
        throw new IclParseError(`expected meta key, got '${keyTok.value}'`, keyTok.line);
      }
      this.expectPunct(':');
      if (keyTok.value === 'risk') {
        const valTok = this.next();
        if (valTok.type !== 'ident' || !RISK_LEVELS.has(valTok.value)) {
          throw new IclParseError(`expected risk level, got '${valTok.value}'`, valTok.line);
        }
        meta.risk = valTok.value as IclRiskLevel;
      } else if (keyTok.value === 'decision') {
        meta.decision = this.expectString('decision');
      } else if (keyTok.value === 'rationale') {
        meta.rationale = this.expectString('rationale');
      } else {
        throw new IclParseError(`unknown meta key '${keyTok.value}'`, keyTok.line);
      }
    }
    this.expectPunct('}');
    return meta;
  }

  private parseFitnessBlock(): IclFitness {
    this.expectIdent('fitness');
    const name = this.expectString('fitness name');
    this.expectPunct('{');

    this.expectIdent('statement');
    this.expectPunct(':');
    const statement = this.expectString('fitness statement');

    this.expectIdent('kind');
    this.expectPunct(':');
    const kindTok = this.next();
    if (kindTok.type !== 'ident' || !FITNESS_KINDS.has(kindTok.value)) {
      throw new IclParseError(`expected fitness kind, got '${kindTok.value}'`, kindTok.line);
    }
    const kind = kindTok.value as IclFitnessKind;

    this.expectIdent('check');
    this.expectPunct(':');
    const check = this.parseCheck();

    this.expectIdent('when');
    this.expectPunct(':');
    const when = this.parseCadence();

    this.expectIdent('on_violation');
    this.expectPunct(':');
    const ovTok = this.next();
    if (ovTok.type !== 'ident' || !VIOLATION_ACTIONS.has(ovTok.value)) {
      throw new IclParseError(`expected on_violation action, got '${ovTok.value}'`, ovTok.line);
    }
    const on_violation = ovTok.value as IclViolationAction;

    this.expectPunct('}');
    return { name, statement, kind, check, when, on_violation };
  }

  private parseCheck(): IclCheck {
    const modeTok = this.next();
    if (modeTok.type !== 'ident' || !['cmd', 'query', 'judge'].includes(modeTok.value)) {
      throw new IclParseError(`expected cmd/query/judge, got '${modeTok.value}'`, modeTok.line);
    }
    const spec = this.expectString('check spec');
    return { mode: modeTok.value as IclCheck['mode'], spec };
  }

  private parseCadence(): IclCadence {
    const modeTok = this.next();
    if (modeTok.type !== 'ident' || !['per_change', 'periodic', 'both'].includes(modeTok.value)) {
      throw new IclParseError(
        `expected per_change/periodic/both, got '${modeTok.value}'`,
        modeTok.line,
      );
    }
    if (modeTok.value === 'per_change') {
      return { mode: 'per_change' };
    }
    this.expectPunct('(');
    const freqTok = this.next();
    if (freqTok.type !== 'ident' || !FREQUENCIES.has(freqTok.value)) {
      throw new IclParseError(`expected frequency, got '${freqTok.value}'`, freqTok.line);
    }
    this.expectPunct(')');
    return {
      mode: modeTok.value as 'periodic' | 'both',
      frequency: freqTok.value as IclFrequency,
    };
  }
}

export function parse(source: string): IclProgram {
  const tokens = tokenize(source);
  return new Parser(tokens).parseProgram();
}
