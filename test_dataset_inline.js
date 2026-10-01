
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
