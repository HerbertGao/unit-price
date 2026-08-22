import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

function majorOf(version, label) {
  const match = /^(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(version);
  if (!match) throw new Error(`${label} has unsupported version "${version}"`);
  return Number(match[1]);
}

function caretMajor(range) {
  const match = /^\^(\d+)(?:\.\d+(?:\.\d+)?)?$/.exec(range.trim());
  if (!match) {
    throw new Error(
      `@tarojs/react has unsupported React peer range "${range}"; update the compatibility check with Taro`,
    );
  }
  return Number(match[1]);
}

export function checkReactCompatibility({ reactVersion, reactDomVersion, taroReactPeer }) {
  const expectedMajor = caretMajor(taroReactPeer);
  const actualMajor = majorOf(reactVersion, 'react');
  majorOf(reactDomVersion, 'react-dom');

  if (actualMajor !== expectedMajor) {
    throw new Error(
      `React ${reactVersion} is incompatible with @tarojs/react peer ${taroReactPeer}`,
    );
  }
  if (reactDomVersion !== reactVersion) {
    throw new Error(
      `react-dom ${reactDomVersion} must exactly match react ${reactVersion}`,
    );
  }
  return { reactVersion, taroReactPeer };
}

async function readPackage(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8'));
}

export async function checkInstalledReactCompatibility() {
  const [react, reactDom, taroReact] = await Promise.all([
    readPackage('../node_modules/react/package.json'),
    readPackage('../node_modules/react-dom/package.json'),
    readPackage('../node_modules/@tarojs/react/package.json'),
  ]);
  return checkReactCompatibility({
    reactVersion: react.version,
    reactDomVersion: reactDom.version,
    taroReactPeer: taroReact.peerDependencies?.react ?? '',
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkInstalledReactCompatibility();
    console.log(`React ${result.reactVersion} satisfies @tarojs/react ${result.taroReactPeer}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
