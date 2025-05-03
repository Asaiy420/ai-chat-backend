import {neon} from "@neondatabase/serverless"
import {drizzle} from "drizzle-orm/neon-http"
import { config } from "dotenv"

// Load the env variable

config({path: '.env'});

if (!process.env.DATABASE_URL){
    throw new Error('Database_url is undefined');
}

// init neon client

const sql = neon(process.env.DATABASE_URL);

//Init Drizzle

export const db = drizzle(sql);