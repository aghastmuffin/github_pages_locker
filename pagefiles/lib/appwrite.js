import { Client, Account, Databases } from "appwrite";

const client = new Client()
  .setEndpoint("https://tor.cloud.appwrite.io/v1")
  .setProject("69d067fc001d50f2d6fa");

const account = new Account(client);
const databases = new Databases(client);

export { client, account, databases };
