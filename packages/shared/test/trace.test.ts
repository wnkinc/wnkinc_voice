import { describe, expect, it } from 'vitest';
import { traceIdOf } from '../src/trace.js';

const xray = 'Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1;Lineage=abc:0';

describe('trace stitching', () => {
  it('extracts the same trace id from either header form', () => {
    expect(traceIdOf(xray)).toBe('5759e988bd862e3fe1be46a994272793');
    expect(traceIdOf('00-5759e988bd862e3fe1be46a994272793-53995c3f42cd8ad8-01')).toBe('5759e988bd862e3fe1be46a994272793');
    expect(traceIdOf(undefined)).toBeUndefined();
  });
});
