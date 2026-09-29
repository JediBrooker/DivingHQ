// Entry point wrangler deploys (main in ../wrangler.toml). The only line
// that needs the Workers runtime is the import below; everything else is
// in watch.js so the tests can run it under Node with a stand-in class.
import { EmailMessage } from "cloudflare:email";
import { createWorker } from "./watch.js";

export default createWorker({ EmailMessage });
