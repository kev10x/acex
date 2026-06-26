const path = require('path');

function loadWithMocks(targetModulePath, mocks = {}) {
  const resolvedTarget = require.resolve(targetModulePath);
  const targetDir = path.dirname(resolvedTarget);
  const restorers = [];

  delete require.cache[resolvedTarget];

  for (const [request, mockExports] of Object.entries(mocks)) {
    const resolvedMock = require.resolve(request, { paths: [targetDir] });
    const originalEntry = require.cache[resolvedMock];

    require.cache[resolvedMock] = {
      id: resolvedMock,
      filename: resolvedMock,
      loaded: true,
      exports: mockExports
    };

    restorers.push(() => {
      if (originalEntry) {
        require.cache[resolvedMock] = originalEntry;
      } else {
        delete require.cache[resolvedMock];
      }
    });
  }

  const loadedModule = require(resolvedTarget);

  return {
    module: loadedModule,
    restore() {
      delete require.cache[resolvedTarget];
      restorers.reverse().forEach((restore) => restore());
    }
  };
}

module.exports = {
  loadWithMocks
};
