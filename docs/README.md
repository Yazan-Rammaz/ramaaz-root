# Ramaaz Root — documentation

The Root console: a management dashboard sitting above the company's projects.
These pages cover how it is built and what it expects from the services around
it.

Open **`index.html`** in a browser for the navigable version. Regenerate it with
`node docs/build.mjs` after editing any page.

---

## Features

### [Login](login/)

The root sign-in flow, end to end — access link, private code, live face
capture, and the stage machine that drives all of it. Start here: everything
else in the console sits behind this.

### [KYC integration](kyc/)

How face verification and ID enrolment work across three services: this
dashboard, the `ramaaz-kyc` Worker, and the root backend. Contains the spec the
backend developer is building against.

---

## How to read these

Two audiences are mixed on purpose, and each page says which it is addressing.
Broadly:

- **Login** is about this repository — screens, routes, and the client state
  machine.
- **KYC integration** is a contract between three parties, so it is written for
  whoever is implementing the other two.

Pages marked **⚠️ TODO** or **OPEN** are waiting on somebody outside this repo.
Those are the ones worth checking first if something does not work.
