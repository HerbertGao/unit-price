import { describe, expect, it } from 'vitest';
import {
  checkInstalledReactCompatibility,
  checkReactCompatibility,
} from './check-react-compat.mjs';

describe('React/Taro compatibility guard', () => {
  it('accepts matching React 18 runtimes in Taro peer range', () => {
    expect(
      checkReactCompatibility({
        reactVersion: '18.3.1',
        reactDomVersion: '18.3.1',
        taroReactPeer: '^18',
      }),
    ).toEqual({ reactVersion: '18.3.1', taroReactPeer: '^18' });
  });

  it('rejects an incompatible React major with actual and supported versions', () => {
    expect(() =>
      checkReactCompatibility({
        reactVersion: '19.2.8',
        reactDomVersion: '19.2.8',
        taroReactPeer: '^18',
      }),
    ).toThrow('React 19.2.8 is incompatible with @tarojs/react peer ^18');
  });

  it('rejects react-dom version drift', () => {
    expect(() =>
      checkReactCompatibility({
        reactVersion: '18.3.1',
        reactDomVersion: '18.2.0',
        taroReactPeer: '^18',
      }),
    ).toThrow('react-dom 18.2.0 must exactly match react 18.3.1');
  });

  it('fails closed for an unsupported peer-range shape', () => {
    expect(() =>
      checkReactCompatibility({
        reactVersion: '18.3.1',
        reactDomVersion: '18.3.1',
        taroReactPeer: '>=18 <20',
      }),
    ).toThrow('unsupported React peer range');
  });

  it('accepts the installed dependency tree', async () => {
    await expect(checkInstalledReactCompatibility()).resolves.toEqual({
      reactVersion: '18.3.1',
      taroReactPeer: '^18',
    });
  });
});
