import { describe, expect, test } from 'bun:test';
import { extractCallerPhone } from '../utils';

describe('extractCallerPhone', () => {
  test('extracts phone from valid SIP From header with + prefix', () => {
    const sipHeaders = [
      { name: 'From', value: 'sip:+15551234567@example.com' },
      { name: 'To', value: 'sip:agent@service.com' },
    ];
    const phone = extractCallerPhone(sipHeaders);
    expect(phone).toBe('+15551234567');
  });

  test('extracts phone without + prefix', () => {
    const sipHeaders = [{ name: 'From', value: 'sip:15551234567@example.com' }];
    const phone = extractCallerPhone(sipHeaders);
    expect(phone).toBe('15551234567');
  });

  test('extracts international phone number', () => {
    const sipHeaders = [
      { name: 'From', value: 'sip:+41797559953@example.com' },
    ];
    const phone = extractCallerPhone(sipHeaders);
    expect(phone).toBe('+41797559953');
  });

  test('handles case-insensitive From header name', () => {
    const sipHeaders = [
      { name: 'from', value: 'sip:+15551234567@example.com' },
    ];
    const phone = extractCallerPhone(sipHeaders);
    expect(phone).toBe('+15551234567');
  });

  test('handles mixed case From header name', () => {
    const sipHeaders = [
      { name: 'FrOm', value: 'sip:+15551234567@example.com' },
    ];
    const phone = extractCallerPhone(sipHeaders);
    expect(phone).toBe('+15551234567');
  });

  test('returns undefined when From header missing', () => {
    const sipHeaders = [{ name: 'To', value: 'sip:agent@service.com' }];
    const phone = extractCallerPhone(sipHeaders);
    expect(phone).toBeUndefined();
  });

  test('returns undefined with invalid SIP format (no sip: prefix)', () => {
    const sipHeaders = [{ name: 'From', value: '+15551234567@example.com' }];
    const phone = extractCallerPhone(sipHeaders);
    expect(phone).toBeUndefined();
  });

  test('returns undefined with completely invalid format', () => {
    const sipHeaders = [{ name: 'From', value: 'invalid-format' }];
    const phone = extractCallerPhone(sipHeaders);
    expect(phone).toBeUndefined();
  });

  test('returns undefined with non-numeric content', () => {
    const sipHeaders = [{ name: 'From', value: 'sip:username@example.com' }];
    const phone = extractCallerPhone(sipHeaders);
    expect(phone).toBeUndefined();
  });

  test('handles empty sipHeaders array', () => {
    const phone = extractCallerPhone([]);
    expect(phone).toBeUndefined();
  });

  test('ignores non-object header entries', () => {
    const sipHeaders = [
      'invalid',
      null,
      42,
      { name: 'From', value: 'sip:+15551234567@example.com' },
    ];
    const phone = extractCallerPhone(sipHeaders);
    expect(phone).toBe('+15551234567');
  });

  test('handles missing value property gracefully', () => {
    const sipHeaders = [{ name: 'From' }];
    const phone = extractCallerPhone(sipHeaders);
    expect(phone).toBeUndefined();
  });

  test('handles null value property', () => {
    const sipHeaders = [{ name: 'From', value: null }];
    const phone = extractCallerPhone(sipHeaders);
    expect(phone).toBeUndefined();
  });

  test('handles undefined value property', () => {
    const sipHeaders = [{ name: 'From', value: undefined }];
    const phone = extractCallerPhone(sipHeaders);
    expect(phone).toBeUndefined();
  });

  test('extracts first match when multiple From headers exist', () => {
    const sipHeaders = [
      { name: 'From', value: 'sip:+15551234567@example.com' },
      { name: 'From', value: 'sip:+15559876543@example.com' },
    ];
    const phone = extractCallerPhone(sipHeaders);
    expect(phone).toBe('+15551234567');
  });

  test('handles complex SIP URI with parameters', () => {
    const sipHeaders = [
      {
        name: 'From',
        value: 'sip:+15551234567@example.com;tag=abc123;branch=xyz',
      },
    ];
    const phone = extractCallerPhone(sipHeaders);
    expect(phone).toBe('+15551234567');
  });

  test('handles display name in From header', () => {
    const sipHeaders = [
      {
        name: 'From',
        value: '"John Doe" <sip:+15551234567@example.com>',
      },
    ];
    const phone = extractCallerPhone(sipHeaders);
    expect(phone).toBe('+15551234567');
  });
});
