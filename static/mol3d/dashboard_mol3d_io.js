(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});
  const app = root.ioApp;
  const transformers = root.ioTransformers;
  if (!app || !transformers) return;

  root.io = {
    setSourcePklInfo: (...args) => app.setSourcePklInfo(...args),
    downloadTextFile: (...args) => app.downloadTextFile(...args),
    saveCurrentFrameXyz: (...args) => app.saveCurrentFrameXyz(...args),
    saveTrajectoryXyz: (...args) => app.saveTrajectoryXyz(...args),
    atomicNumberToElement: (...args) => transformers.atomicNumberToElement(...args),
    buildXyzFrames: (...args) => transformers.buildXyzFrames(...args),
    syncGifExportRangeFromInputs: (...args) => app.syncGifExportRangeFromInputs(...args),
    exportTrajectoryGif: (...args) => app.exportTrajectoryGif(...args),
    cancelGifExport: (...args) => app.cancelGifExport(...args),
    loadTrajectory: (...args) => app.loadTrajectory(...args),
    setNacVectorsVisible: (...args) => app.setNacVectorsVisible(...args),
    setDeVectorsVisible: (...args) => app.setDeVectorsVisible(...args),
    setDeNacVectorsVisible: (...args) => app.setDeNacVectorsVisible(...args),
    updateNacStatePairFromControls: (...args) => app.updateNacStatePairFromControls(...args),
    updateDeStatePairFromControls: (...args) => app.updateDeStatePairFromControls(...args),
    addDeRow: (...args) => app.addDeRow(...args),
    removeDeRow: (...args) => app.removeDeRow(...args),
    toggleDeRowEnabled: (...args) => app.toggleDeRowEnabled(...args),
    updateDeRowPair: (...args) => app.updateDeRowPair(...args),
    loadNacPair: (...args) => app.loadNacPair(...args),
    loadDePair: (...args) => app.loadDePair(...args),
    loadDeNacPair: (...args) => app.loadDeNacPair(...args),
  };
})();
