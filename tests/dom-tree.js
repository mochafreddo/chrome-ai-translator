function captureDomTree(root) {
  const graph = [];
  function capture(node) {
    graph.push({ node, children: [...node.childNodes], value: node.nodeValue });
    node.childNodes.forEach(capture);
  }
  capture(root);
  return {
    children: graph[0].children,
    matches() {
      return graph.every(({ node, children, value }) => node.nodeValue === value &&
        node.childNodes.length === children.length &&
        children.every((child, index) => node.childNodes[index] === child));
    },
  };
}

module.exports = { captureDomTree };
