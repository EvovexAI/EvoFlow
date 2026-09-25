"""用 Node 模拟 document.documentElement.dataset.scifiUi = '1'
确认实际生成的 HTML attribute 名"""
import subprocess
import os

# 把 HTML 嵌进一个最简单的 jsdom-free 测试,直接在 stdout 打印
js_test = '''
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
const root = dom.window.document.documentElement;
root.dataset.scifiUi = '1';

const attrs = [];
for (let attr of root.attributes) attrs.push(attr.name + '="' + attr.value + '"');

console.log('=== Output attributes on <html> ===');
attrs.forEach(a => console.log(a));
console.log('=== Test selectors ===');
['[data-scifi-ui]', '[data-scifiui]', '[data-scifIui]', '[data-scifiUi]'].forEach(s => {
  console.log(s + ' matches:', root.matches(s));
});
'''

# 写到临时文件
test_file = 'd:/dev/github/EvoFlow/test_dataset_inline.js'
with open(test_file, 'w', encoding='utf-8') as f:
    f.write(js_test)

result = subprocess.run(['node', test_file], capture_output=True, text=True, encoding='utf-8')
print("STDOUT:", result.stdout)
print("STDERR:", result.stderr)
