import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const version = await db.query("select version()");
console.log(version.rows[0].version);

await db.exec(`
  create table probe (
    id serial primary key,
    name text not null,
    meta jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );
`);
await db.query("insert into probe(name, meta) values ($1, $2::jsonb)", [
  "hello",
  JSON.stringify({ a: 1 }),
]);
const rows = await db.query("select * from probe where name = $1", ["hello"]);
console.log(JSON.stringify(rows.rows));

// Confirm the features the schema depends on.
const features = await db.query(`
  select
    (select count(*) from information_schema.tables where table_schema='public') as tables,
    (select count(*) from pg_indexes where schemaname='public') as indexes,
    (select count(*) from pg_proc) as functions
`);
console.log(JSON.stringify(features.rows[0]));

await db.close();
