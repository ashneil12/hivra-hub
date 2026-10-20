import { createServer } from "./server.ts";
import { Store } from "./store.ts";

const port = Number(process.env.PORT ?? 4317);
const store = new Store(process.env.TALLY_DATA ?? "./data.json");
createServer(store).listen(port, () => console.log(`tally api on http://localhost:${port}`));
