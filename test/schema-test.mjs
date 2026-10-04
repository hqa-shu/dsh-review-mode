/**
 * 工具输出 schema 的自检。
 *
 * 踩过的坑：`output.schema` 用的是标准 JSON Schema —— `required` 必须是**数组**、
 * 放在 object 那一层。写成工具 `parameters` 那种「每个属性上 required: true」会被
 * 判 `unsupported JSON schema`，工具注册失败，**整个预设声明跟着 broken，预设从
 * 模式选择器里彻底消失**。这个测试就是防止再犯。
 */
const mod = await import(new URL('../reviewer.js', import.meta.url).pathname);
const tools = new Map();
mod.apply({
  effect: (fn) => fn(),
  logger: { warn() {} },
  tools: { restrict: () => () => {}, register: (def) => tools.set(def.name, def) },
});

const problems = [];
const walk = (node, path) => {
  if (node === null || typeof node !== 'object') return;
  if (node.required !== undefined && (node.type !== 'object' || !Array.isArray(node.required))) {
    problems.push(`${path}.required is not supported on type "${node.type}"`);
  }
  for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, `${path}.properties.${key}`);
  if (node.items !== undefined) walk(node.items, `${path}.items`);
};
for (const [name, def] of tools) {
  // parameters 必须是编译后的 schema：type 为 object，且不含属性级 required。
  if (def.parameters?.type !== 'object') {
    problems.push(`${name}.parameters.type must be "object" (got ${JSON.stringify(def.parameters?.type ?? null)})`);
  }
  walk(def.parameters, `${name}.parameters`);
  if (def.output?.schema !== undefined) walk(def.output.schema, `${name}.output.schema`);
}
if (problems.length > 0) {
  console.log('FAIL  output.schema 里有不支持的 required：');
  for (const line of problems) console.log('  ', line);
  process.exit(1);
}
console.log(`PASS  parameters + output.schema 合法（${tools.size} 个工具：${[...tools.keys()].join(', ')}）`);
