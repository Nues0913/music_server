import { createUploadClient } from './uploads/client.js';
import { createUploadController } from './uploads/controller.js';
import { createUploadView, bindUploadEvents } from './uploads/view.js';

const view = createUploadView(document);
const controller = createUploadController(view, createUploadClient());
const unbind = bindUploadEvents(document, controller, view);
void controller.initialize();
window.addEventListener('pagehide', event => {
  if (!event.persisted) { controller.dispose(); unbind(); }
});
