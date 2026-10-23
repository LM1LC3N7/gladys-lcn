// -----------------------------------------------------------------------------
// Names and messages, French and English.
// -----------------------------------------------------------------------------

export const word = (entry, language) => entry?.[language] ?? entry?.en ?? '';

/** An entry whose values are functions -> the entry of their results. */
export const fill = (entry, ...args) =>
  Object.fromEntries(
    Object.entries(entry).map(([lang, value]) => [
      lang,
      typeof value === 'function' ? value(...args) : value,
    ]),
  );

/** The name of a module when it gives none. */
export const DEVICE_NAME = {
  fr: (hardware, label) => `${hardware} ${label}`,
  en: (hardware, label) => `${hardware} ${label}`,
};

const portName = {
  fr: (port) => port.toUpperCase().replace(/^SP/, 'Consigne '),
  en: (port) => port.toUpperCase().replace(/^SP/, 'Set point '),
};

/** Feature names: `<port> <what>`. */
export const ROLE_NAMES = {
  state: { fr: 'état', en: 'state' },
  level: { fr: 'niveau', en: 'level' },
  on: { fr: 'allumer', en: 'turn on' },
  off: { fr: 'éteindre', en: 'turn off' },
  light: { fr: 'lumière', en: 'light' },
  brightness: { fr: 'luminosité', en: 'brightness' },
  switch: { fr: 'interrupteur', en: 'switch' },
  binary: { fr: 'entrée', en: 'input' },
  motion: { fr: 'mouvement', en: 'motion' },
  temperature: { fr: 'température', en: 'temperature' },
  humidity: { fr: 'humidité', en: 'humidity' },
  lux: { fr: 'luminosité ambiante', en: 'illuminance' },
  co2: { fr: 'CO2', en: 'CO2' },
  value: { fr: 'valeur', en: 'value' },
  setpoint: { fr: '(lecture seule)', en: '(read only)' },
};

export const featureName = (port, role, language) =>
  `${word(portName, language)(port)} ${word(ROLE_NAMES[role], language)}`;

const nothing = { fr: " : rien n'a été envoyé.", en: ': nothing was sent.' };

/** Connection status and command messages. */
export const T = {
  noHost: {
    en: 'Enter the address of the computer running LCN-PCHK in the configuration.',
    fr: "Saisissez l'adresse de l'ordinateur où tourne LCN-PCHK dans la configuration.",
  },
  noUser: {
    en: 'Enter the user name of LCN-PCHK in the configuration.',
    fr: "Saisissez le nom d'utilisateur de LCN-PCHK dans la configuration.",
  },
  badCredentials: {
    en: 'The user name or the password holds a line break or another control character: they are never sent. Type them again.',
    fr: "Le nom d'utilisateur ou le mot de passe contient un retour à la ligne ou un autre caractère de contrôle : ils ne sont jamais envoyés. Saisissez-les de nouveau.",
  },
  sceneCancelled: {
    en: 'A "turn off" of this module was asked meanwhile: the LCN scene was not sent.',
    fr: "Un « éteindre » de ce module a été demandé entre-temps : la scène LCN n'a pas été envoyée.",
  },
  connecting: { en: 'Connecting to LCN-PCHK…', fr: 'Connexion à LCN-PCHK…' },
  scanning: {
    en: 'Connected to LCN-PCHK; looking for the modules on the bus…',
    fr: 'Connecté à LCN-PCHK ; recherche des modules sur le bus…',
  },
  connected: {
    en: (modules, extra) => `Connected to LCN-PCHK: ${modules} module(s).${extra}`,
    fr: (modules, extra) => `Connecté à LCN-PCHK : ${modules} module(s).${extra}`,
  },
  busDown: {
    en: (modules) =>
      `Connected to LCN-PCHK, but PCHK says the LCN bus is disconnected (coupler unplugged?). ${modules} module(s) known.`,
    fr: (modules) =>
      `Connecté à LCN-PCHK, mais PCHK indique que le bus LCN est déconnecté (coupleur débranché ?). ${modules} module(s) connu(s).`,
  },
  portErrors: {
    en: (list) => ` Not understood in "Ports": ${list}.`,
    fr: (list) => ` Non compris dans « Ports » : ${list}.`,
  },
  scanFailed: {
    en: (reason) =>
      `Connected, but the scan of the modules failed (${reason}); it is tried again at the next connection or with Scan.`,
    fr: (reason) =>
      `Connecté, mais la recherche des modules a échoué (${reason}) ; nouvel essai à la prochaine connexion ou avec Scanner.`,
  },
  unreachable: {
    en: (reason, seconds) => `LCN-PCHK unreachable (${reason}), next try in ${seconds} s.`,
    fr: (reason, seconds) => `LCN-PCHK injoignable (${reason}), nouvel essai dans ${seconds} s.`,
  },
  licence: {
    en: (minutes) =>
      `LCN-PCHK refused the connection: licence error (all its connections are taken). Next try in ${minutes} min; free a connection of PCHK or add a licence.`,
    fr: (minutes) =>
      `LCN-PCHK a refusé la connexion : erreur de licence (toutes ses connexions sont prises). Nouvel essai dans ${minutes} min ; libérez une connexion de PCHK ou ajoutez une licence.`,
  },
  refused: {
    en: 'LCN-PCHK refused the user name or the password (or closed the session right after the password, twice in a row). Connection stopped, no new try with these credentials: enter the right ones and save, or click "Test the connection" once fixed on the PCHK side.',
    fr: "LCN-PCHK a refusé le nom d'utilisateur ou le mot de passe (ou a fermé la session juste après le mot de passe, deux fois de suite). Connexion arrêtée, sans nouvel essai avec ces identifiants : saisissez les bons puis enregistrez, ou cliquez sur « Tester la connexion » une fois corrigé côté PCHK.",
  },
  tooSoon: {
    en: (seconds) => `A connection was tried just now; try again in ${seconds} s.`,
    fr: (seconds) => `Une connexion vient d'être tentée ; réessayez dans ${seconds} s.`,
  },
  stillConnecting: {
    en: 'LCN-PCHK does not answer yet; try again in a moment.',
    fr: 'LCN-PCHK ne répond pas encore ; réessayez dans un instant.',
  },
  offline: {
    en: `LCN-PCHK is not connected${nothing.en}`,
    fr: `LCN-PCHK n'est pas connecté${nothing.fr}`,
  },
  busOffline: {
    en: `PCHK says the LCN bus is disconnected${nothing.en}`,
    fr: `PCHK indique que le bus LCN est déconnecté${nothing.fr}`,
  },
  readOnly: {
    en: `This feature is read only${nothing.en}`,
    fr: `Cette fonctionnalité est en lecture seule${nothing.fr}`,
  },
  notDeclared: {
    en: `This port is not declared as a light or a switch in "Ports" (any more)${nothing.en} Use its "turn on" / "turn off" buttons, or declare it.`,
    fr: `Ce port n'est pas (plus) déclaré comme lumière ou interrupteur dans « Ports »${nothing.fr} Utilisez ses boutons « allumer » / « éteindre », ou déclarez-le.`,
  },
  buttonsDisabled: {
    en: `The "turn on" / "turn off" buttons of the ports are disabled in the configuration${nothing.en}`,
    fr: `Les boutons « allumer » / « éteindre » des ports sont désactivés dans la configuration${nothing.fr}`,
  },
  scenesDisabled: {
    en: `Activating LCN scenes from Gladys is disabled in the configuration${nothing.en}`,
    fr: `L'activation des scènes LCN depuis Gladys est désactivée dans la configuration${nothing.fr}`,
  },
  cancelled: {
    en: `A "turn off" of the same port was asked meanwhile${nothing.en}`,
    fr: `Un « éteindre » du même port a été demandé entre-temps${nothing.fr}`,
  },
  badValue: {
    en: (value) => `Value ${value} not understood${nothing.en}`,
    fr: (value) => `Valeur ${value} non comprise${nothing.fr}`,
  },
  badModule: {
    en: `This is not an LCN module of this integration${nothing.en}`,
    fr: `Ce n'est pas un module LCN de cette intégration${nothing.fr}`,
  },
  tooLate: {
    en: `PCHK was too busy to send the command in time${nothing.en}`,
    fr: `PCHK était trop occupé pour envoyer la commande à temps${nothing.fr}`,
  },
  queueFull: {
    en: `Too many commands are waiting for PCHK${nothing.en}`,
    fr: `Trop de commandes attendent PCHK${nothing.fr}`,
  },
  unconfirmed: {
    en: (what) =>
      `Sent to the bus (${what}), without confirmation from the module in time: the state is read again in 2 s.`,
    fr: (what) =>
      `Envoyé sur le bus (${what}), sans confirmation du module dans les temps : l'état est relu dans 2 s.`,
  },
  scenePartial: {
    en: 'The scene register was changed, but the scene itself was not sent (the option was switched off, a "turn off" of the module was asked, or the connection ended).',
    fr: "Le registre de scènes a été changé, mais la scène elle-même n'a pas été envoyée (l'option a été désactivée, un « éteindre » du module a été demandé, ou la connexion a été coupée).",
  },
};

/** What a command does, for the logs and the messages. */
export const COMMAND_NAMES = {
  output: { en: (id, p) => `${id} to ${p} %`, fr: (id, p) => `${id} à ${p} %` },
  relay: {
    en: (id, on) => `${id} ${on ? 'on' : 'off'}`,
    fr: (id, on) => `${id} ${on ? 'allumé' : 'éteint'}`,
  },
  scene: {
    en: (id, r, s) => `${id} scene ${s} of register ${r}`,
    fr: (id, r, s) => `${id} scène ${s} du registre ${r}`,
  },
};
