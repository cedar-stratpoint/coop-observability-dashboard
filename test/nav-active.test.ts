import {describe, expect, it} from 'vitest';
import {leafActive, pathUnder} from '../src/nav-active';

describe('pathUnder', () => {
  it('matches the path itself and its subpaths, never a sibling that shares a prefix', () => {
    expect(pathUnder('/health', '/health')).toBe(true);
    expect(pathUnder('/health', '/health/qrr')).toBe(true);
    expect(pathUnder('/health', '/health-report')).toBe(false);
    expect(pathUnder('/health-report', '/health-report')).toBe(true);
    expect(pathUnder('/health-report', '/health')).toBe(false);
  });
});

describe('leafActive', () => {
  it('lights Business Health only on /health, and Business Health Report only on /health-report', () => {
    expect(leafActive('/health', '/health', null)).toBe(true);
    expect(leafActive('/health', '/health-report', null)).toBe(false);
    expect(leafActive('/health-report', '/health-report', null)).toBe(true);
    expect(leafActive('/health-report', '/health', null)).toBe(false);
  });
  it('keeps the existing Overview, Sales and Offline Sales rules', () => {
    expect(leafActive('/', '/', null)).toBe(true);
    expect(leafActive('/', '/', 'all')).toBe(false);
    expect(leafActive('/?channel=all', '/', 'shopee')).toBe(true);
    expect(leafActive('/offline-sales', '/offline-sales/rankings', null)).toBe(true);
    expect(leafActive('/offline-sales', '/offline-sales/orders', null)).toBe(false);
    expect(leafActive('/offline-sales/orders', '/offline-sales/orders/x', null)).toBe(true);
    expect(leafActive('/offline-sales/events', '/offline-sales/events', null)).toBe(true);
    expect(leafActive('/stock', '/stock/skus', null)).toBe(false);
    expect(leafActive('/stock/skus', '/stock/skus', null)).toBe(true);
    expect(leafActive('/customers', '/customers/leads', null)).toBe(true);
    expect(leafActive('/inventory', '/inventory/ABC', null)).toBe(true);
  });
});
