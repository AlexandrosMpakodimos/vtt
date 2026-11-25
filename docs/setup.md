# Local setup

[Ελληνικά](setup.el.md) · [Back to README](../README.md)

How to run the app on your own computer.

> **Windows:** type every command in **Command Prompt** (`cmd`), not PowerShell, which blocks `npm`.

## 1. Requirements

You need **Node.js 22** and **PostgreSQL 16 or newer**.

**With an installer:**

- Node.js: <https://nodejs.org> (version 22)
- PostgreSQL:
  - Windows: <https://www.postgresql.org/download/windows/>. The installer asks for a password for the
    `postgres` user. Keep it, you need it in step 4.
  - macOS: [Postgres.app](https://postgresapp.com). Open it and click **Initialize**.

**From the command line:**

- macOS ([Homebrew](https://brew.sh)):

  ```sh
  brew install node@22 postgresql@17
  brew link --force node@22 postgresql@17
  brew services start postgresql@17
  ```

- Windows (cmd). The PostgreSQL installer asks for a password for the `postgres` user. Keep it.

  ```sh
  winget install OpenJS.NodeJS.22
  winget install PostgreSQL.PostgreSQL.17 --interactive
  ```

  Open a new Command Prompt window when it finishes.

- Linux (Ubuntu 24.04 or newer):

  ```sh
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs postgresql
  ```

Check with `node -v` (it should print `v22…`).

## 2. Get the code

[Download the ZIP](https://github.com/AlexandrosMpakodimos/vtt/archive/refs/heads/main.zip) and unzip it, or use Git:

```sh
git clone https://github.com/AlexandrosMpakodimos/vtt.git
```

The ZIP creates a `vtt-main` folder, Git creates `vtt`. Open a terminal **inside that folder**:

- Windows: open the folder in File Explorer, click the address bar, type `cmd` and press Enter.
- macOS / Linux: `cd` into it, e.g. `cd ~/Downloads/vtt-main`. Put the path in quotes if it contains spaces.

## 3. Install dependencies

```sh
npm ci
```

You may see warnings about vulnerabilities or a newer npm version. They do not affect running the app locally.
**Do not run `npm audit fix`**: it changes the tested dependency versions.

## 4. Create the database

Open the PostgreSQL console (`psql`):

- **Windows:** search the Start Menu for "SQL Shell (psql)" and open it. Press Enter at every prompt except
  `Password for user postgres`, where you type the password from step 1. Or, from Command Prompt (change `17`
  if you installed another version): `"C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres`
- **macOS:** in Postgres.app, double-click the `postgres` database. With Homebrew: `psql postgres`
- **Linux:** `sudo -u postgres psql`

Then enter these two lines:

```sql
CREATE ROLE vtt LOGIN PASSWORD 'vtt-local';
CREATE DATABASE vtt OWNER vtt;
```

This creates a separate user just for the app: `vtt` is the user name and `vtt-local` its password. It is not
the `postgres` admin password from step 1. If you change either, change it in `DATABASE_URL` in `.env` too
(step 5).

Type `\q` to leave the console.

## 5. Create the settings file

Windows:

```sh
copy .env.example .env
```

macOS / Linux:

```sh
cp .env.example .env
```

Optionally, open `.env` in a text editor (e.g. `notepad .env` on Windows) and set `SESSION_SECRET` to at least
32 characters: Latin letters, digits, `-` or `_`.

## 6. Create the tables and start

```sh
npm run migrate
npm start
```

When the terminal shows `STARTUP_READY`, open <http://localhost:3000> in your browser.

## 7. Sign up

Create an account. Running locally, the app sends no email: the terminal prints a line starting with
`Verification link`. Open that address in your browser, then log in.

To see the real-time updates, create a second account in a private window (or another browser) and join the
same game.

> Uploading image files needs a cloud storage service (e.g. Cloudflare R2) and is not available locally. You
> can still add images by link (URL).

To stop the app, press `Ctrl + C` in its terminal (`control + C` on macOS).
