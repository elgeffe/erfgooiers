import { createCoOpServer } from './server';

const port = Number(process.env.PORT || 8787);
const app = createCoOpServer();

app.listen(port, '0.0.0.0').then(actualPort => {
  console.log(`Erfgooiers co-op room service listening on http://0.0.0.0:${actualPort}`);
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => app.close().finally(() => process.exit(0)));
}
