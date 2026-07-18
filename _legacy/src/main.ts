// Use the root bootstrap so the full application (UI, assets, postprocessing)
// is initialized when the dev server loads `/src/main.ts` as the entry.
// This ensures the UIManager, asset loading, and auto-HDRI logic run.
import '../main';

// Helpful debug log so it's obvious the full bootstrap was imported
console.log('Imported root bootstrap (full app)');
