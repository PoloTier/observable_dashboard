// Main entry point for 3D molecule viewer
// Dynamically loads bootstrap data from API

async function loadBootstrap() {
  try {
    const response = await fetch('/api/bootstrap');
    if (!response.ok) {
      throw new Error(`Failed to load bootstrap: ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Bootstrap load error:', error);
    showBootError(`Failed to load configuration: ${error.message}`);
    throw error;
  }
}

function showBootError(message) {
  const box = document.createElement('div');
  box.style.margin = '12px';
  box.style.padding = '10px 12px';
  box.style.border = '1px solid #d33';
  box.style.borderRadius = '6px';
  box.style.background = '#fff6f6';
  box.style.color = '#b00020';
  box.style.font = '14px/1.4 sans-serif';
  box.textContent = message;
  document.body.prepend(box);
}

// Initialize 3D viewer after bootstrap data is loaded
async function initMolecule3D() {
  const bootstrap = await loadBootstrap();

  // Inject bootstrap data into a script tag for compatibility with existing code
  const scriptEl = document.createElement('script');
  scriptEl.id = 'bootstrap-json';
  scriptEl.type = 'application/json';
  scriptEl.textContent = JSON.stringify(bootstrap);
  document.head.appendChild(scriptEl);

  // Load molecule3d modules in order
  const modules = [
    '/assets/dashboard/dashboard_state.js',
    '/assets/dashboard/dashboard_data_loader.js',
    '/assets/math/dashboard_math3d.js',
    '/assets/mol3d/dashboard_mol3d_constants.js',
    '/assets/mol3d/dashboard_mol3d_shared.js',
    '/assets/mol3d/dashboard_mol3d_utils.js',
    '/assets/mol3d/dashboard_mol3d_geometry.js',
    '/assets/mol3d/dashboard_mol3d_viewer.js',
    '/assets/mol3d/dashboard_mol3d_measurement.js',
    '/assets/mol3d/dashboard_mol3d_vector_overlay.js',
    '/assets/mol3d/dashboard_mol3d_store.js',
    '/assets/mol3d/dashboard_mol3d_io_vector_ops.js',
    '/assets/mol3d/dashboard_mol3d_io_transformers.js',
    '/assets/mol3d/dashboard_mol3d_io_network.js',
    '/assets/mol3d/dashboard_mol3d_io_app.js',
    '/assets/mol3d/dashboard_mol3d_io.js',
    '/assets/mol3d/dashboard_mol3d_page.js'
  ];

  for (const src of modules) {
    await loadScript(src);
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.body.appendChild(script);
  });
}

// Start initialization
initMolecule3D().catch(error => {
  console.error('Molecule3D initialization failed:', error);
});
