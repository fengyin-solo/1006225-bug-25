// Node ESM loader：tsc 输出保留了 '@/...' 别名与无扩展名的相对导入，这里统一解析。
import { pathToFileURL } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const url = pathToFileURL(`${process.cwd()}/scripts/dist-test/${specifier.slice(2)}.js`).href
    return nextResolve(url, context)
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?js$/.test(specifier)) {
    return nextResolve(`${specifier}.js`, context)
  }
  return nextResolve(specifier, context)
}
