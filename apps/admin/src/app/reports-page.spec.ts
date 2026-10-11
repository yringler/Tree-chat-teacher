import '@angular/compiler'; // JIT: @tangent/web-shared, imported here, links its components on load.
import { REPORT_CATEGORIES } from '@tangent/shared';
import { describe, expect, it } from 'vitest';
import { holdReportRequest } from './holds-page';
import { holdReasonFor, REPORT_CATEGORY_LABELS, shareStateClass } from './reports-page';

describe('ReportsPage', () => {
  it('names every category', () => {
    for (const c of REPORT_CATEGORIES) expect(REPORT_CATEGORY_LABELS[c]).toBeTruthy();
  });

  it('colours a share by whether the public sees it', () => {
    expect(shareStateClass('active')).toBe('badge-ok');
    expect(shareStateClass('pending_review')).toBe('badge-danger');
    expect(shareStateClass('removed')).toBe('badge-danger');
    expect(shareStateClass('deleted')).toBe('badge-warn');
  });

  it('holds a report for its own reason where there is one', () => {
    expect(holdReasonFor('csam')).toBe('csam');
    expect(holdReasonFor('violent_or_illegal')).toBe('violent_or_illegal');
    expect(holdReasonFor('defamation')).toBe('other');
  });
});

describe('HoldsPage: the report request', () => {
  it('sends the trimmed number, and refuses what the server would', () => {
    expect(holdReportRequest({ kind: 'ncmec', reference: ' CT-1 ' })).toEqual({
      kind: 'ncmec',
      reference: 'CT-1',
    });
    expect(holdReportRequest({ kind: 'law_enforcement', reference: '  ' })).toBe(
      'Enter the report number you were given.',
    );
    expect(typeof holdReportRequest({ kind: 'ncmec', reference: 'x'.repeat(201) })).toBe('string');
  });
});
