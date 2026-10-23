# LCN pour Gladys Assistant

Cette intégration relie Gladys à une installation **LCN** (Local Control
Network, domotique de bâtiment vendue surtout en Allemagne, en Autriche et
en Suisse) par **LCN-PCHK**, le logiciel coupleur de LCN qui tourne sur un
ordinateur de votre réseau (avec sa licence) et est relié au bus par un
coupleur LCN-PKU ou LCN-PCK.

> **Jamais testé avec un vrai appareil** ni une vraie installation : le
> protocole est porté de pypck, la bibliothèque de l'intégration LCN de Home
> Assistant. Non officiel, sans lien avec LCN (ISSENDORFF KG).

## Ce qu'elle fait

- Se connecte à PCHK avec son nom d'utilisateur et son mot de passe, trouve
  les coupleurs de segments, puis chaque module du bus (la même recherche
  que pypck), avec son numéro de série, son firmware, son type et le nom
  défini dans LCN-PRO.
- Un appareil Gladys par module. Ses fonctionnalités viennent du champ
  **Ports** :
  - **sorties A1 à A4** et **relais R1 à R8** : **en lecture seule par
    défaut** (leur état, et le niveau d'une sortie) avec des boutons
    « allumer » / « éteindre » **désactivés par défaut**. Déclarés `light`
    (une sortie : une lumière avec sa luminosité ; un relais : une lumière
    tout ou rien) ou `switch`, ils se commandent depuis Gladys ;
  - **capteurs binaires B1 à B8** : une entrée, ou un détecteur de mouvement
    (`motion`) ;
  - **variables** TVAR, R1VAR, R2VAR, VAR1 à VAR12 : une température (°C, par
    défaut), `humidity` (%), `lux` (capteur de lumière sur le port I), `co2`
    (ppm) ou une valeur brute `value` ;
  - **consignes** R1VARSETPOINT, R2VARSETPOINT des régulateurs : en lecture
    seule.
    Un module absent de Ports montre A1 et A2, en lecture seule.
- Les **touches qu'un module envoie à l'hôte** (programmées avec LCN-PRO)
  deviennent un déclencheur de scène « Touche LCN envoyée à l'hôte » : module
  (`M5`, ou `S12M5` sur le segment 12), table A à C, touche 1 à 8, appui court
  (hit), appui long (make) ou relâchement (break).
- Une action de scène « Activer une scène LCN » (registre 0-9, scène 0-9,
  pour les sorties, les relais ou les deux), **désactivée par défaut**.

## Configuration

| Champ                                            | À saisir                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adresse de LCN-PCHK                              | L'adresse IP de l'ordinateur où tourne PCHK (donnez-lui une adresse fixe).                                                                                                                                                                                                        |
| Port                                             | 4114 sauf changement dans PCHK.                                                                                                                                                                                                                                                   |
| Nom d'utilisateur, mot de passe                  | Ceux de PCHK. Le mot de passe est un champ secret : gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement à PCHK, jamais écrit dans les journaux. PCHK le reçoit en clair sur votre réseau : son protocole n'est pas protégé, gardez PCHK sur un réseau de confiance. |
| Mode de variation                                | 200 pas quand tous les modules ont un firmware de 2013 (170206) ou après, comme LCN-PRO le programme ; sinon 50 pas.                                                                                                                                                              |
| Ports                                            | Voir ci-dessous.                                                                                                                                                                                                                                                                  |
| Autoriser les boutons « allumer » / « éteindre » | Désactivé par défaut.                                                                                                                                                                                                                                                             |
| Autoriser l'activation des scènes LCN            | Désactivé par défaut.                                                                                                                                                                                                                                                             |

### Ports

Des entrées séparées par des virgules : `module.port` ou `module.port:type`,
le module numéroté comme dans LCN-PRO (`M5`, `5`, ou `S12M5` sur le segment
12). Exemple :

```
M5.A1:light, M5.A2:switch, M5.R3:switch, M5.B1:motion, M7.TVAR, M7.VAR4:humidity, M7.R1VARSETPOINT
```

**Ne déclarez jamais en `light` ou `switch` un port qui commande une pompe,
un chauffage, une demande de chaudière, une gâche, une vanne, un congélateur
ou tout ce qu'un « éteindre » ou « allumer » soudain pourrait abîmer** : une
lumière ou un interrupteur obéit à Google Home, Alexa, au MCP (« éteins
tout ») et à toutes les scènes. Laissez ces ports en lecture seule.

Un port qui change de type reçoit de nouvelles fonctionnalités ; celles déjà
créées sont gardées avec leur historique (supprimez-les dans Gladys si vous
n'en voulez plus). Une lumière ou un interrupteur gardé refuse les commandes
dès que le port n'est plus déclaré ainsi.

## Sécurité

- Une commande est écrite en 3,5 s ou pas du tout (« rien n'a été envoyé ») ;
  elle n'est confirmée que par un état du port, reçu après elle, égal à la
  valeur demandée ; sinon Gladys affiche « envoyé, sans confirmation » et le
  port est relu 2 s plus tard.
- Un « éteindre » (0 %, relais coupé) passe avant toute lecture et annule un
  « allumer » du même port encore en attente.
- Les options sont vérifiées à l'arrivée de la commande et de nouveau juste
  avant son écriture.
- Un nom d'utilisateur ou un mot de passe refusé par PCHK arrête la
  connexion : aucun nouvel essai avec les mêmes identifiants, même après un
  redémarrage (une empreinte salée des identifiants refusés est gardée dans
  `/data`, jamais le mot de passe ; elle est effacée à la première connexion
  réussie). Saisissez d'autres identifiants, ou cliquez sur « Tester la
  connexion » une fois corrigé côté PCHK (un essai, jamais à moins de 10 s du
  précédent).
- Une erreur de licence de PCHK (toutes ses connexions prises) met en pause
  5 min, puis 15 min, 30 min, 1 h ; la pause survit à un redémarrage.
- Les tentatives de connexion sont espacées (10 s, 30 s, 1 min, 2 min, puis
  5 min) et un redémarrage garde l'espacement ; une lecture complète des
  états a lieu au plus une fois par minute ; « Scanner » relance la recherche
  au plus une fois par minute.

## Limites

- LCN-PCHK seulement : ni LCN-PKE (coupleur IP direct) ni USB.
- Pas de volets (moteurs), seuils, LED, verrouillages de touches ou de
  régulateurs, ni contrôle d'accès dans cette version ; les consignes sont en
  lecture seule.
- Les modules qui ne répondent pas à la recherche peuvent être listés dans
  Ports.
- Le bus ne dit pas quels ports sont câblés : listez-les dans Ports.
- Docker n'est pas utilisé pendant le développement : l'image n'a jamais
  tourné dans Gladys.
