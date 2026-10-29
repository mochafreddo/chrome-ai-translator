const assert = require('node:assert/strict');
const { captureDomTree } = require('./dom-tree');

exports.name = 'DOM tree';
exports.tests = [{
  name: 'matches an unchanged tree',
  fn() {
    const text = { nodeValue: 'hello', childNodes: [] };
    const root = { nodeValue: null, childNodes: [text] };
    const captured = captureDomTree(root);
    assert.equal(captured.matches(), true);
    assert.deepEqual(captured.children, [text]);
  },
}, {
  name: 'rejects replacement of a text node with identical text',
  fn() {
    const root = { nodeValue: null, childNodes: [{ nodeValue: 'hello', childNodes: [] }] };
    const captured = captureDomTree(root);
    root.childNodes[0] = { nodeValue: 'hello', childNodes: [] };
    assert.equal(captured.matches(), false);
  },
}, {
  name: 'rejects reordered children',
  fn() {
    const root = { nodeValue: null, childNodes: [
      { nodeValue: 'first', childNodes: [] }, { nodeValue: 'second', childNodes: [] },
    ] };
    const captured = captureDomTree(root);
    root.childNodes.reverse();
    assert.equal(captured.matches(), false);
  },
}, {
  name: 'rejects changed text',
  fn() {
    const text = { nodeValue: 'hello', childNodes: [] };
    const captured = captureDomTree({ nodeValue: null, childNodes: [text] });
    text.nodeValue = 'goodbye';
    assert.equal(captured.matches(), false);
  },
}, {
  name: 'rejects removed or inserted children',
  fn() {
    const root = { nodeValue: null, childNodes: [{ nodeValue: 'hello', childNodes: [] }] };
    const captured = captureDomTree(root);
    const child = root.childNodes.pop();
    assert.equal(captured.matches(), false);
    root.childNodes.push(child, { nodeValue: 'extra', childNodes: [] });
    assert.equal(captured.matches(), false);
  },
}, {
  name: 'can be serialized for page evaluation',
  fn() {
    const vm = require('node:vm');
    const capture = vm.runInNewContext(`(${captureDomTree.toString()})`);
    const text = { nodeValue: 'hello', childNodes: [] };
    const captured = capture({ nodeValue: null, childNodes: [text] });
    assert.equal(captured.matches(), true);
    text.nodeValue = 'goodbye';
    assert.equal(captured.matches(), false);
  },
}];
