import './config.ts';
import { createApplication } from './app.ts';

const application = await createApplication();
const port = Number(process.env.PORT) || 3001;
application.server.listen(port, () => console.log(`游戏大厅与 WebSocket 运行在 http://localhost:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void application.close().then(() => process.exit(0)); });
}
