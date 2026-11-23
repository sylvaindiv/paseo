# Projets

Chaque projet a une liste dans le fichier `projects-todos.sqlite3` du daemon Paseo.
Sur le Mac, le chemin par défaut est `~/.paseo/projects-todos.sqlite3`. Un daemon démarré avec
`PASEO_HOME` utilise ce dossier. Le plugin crée le fichier au premier accès.

La base contient les tâches, les sous-tâches, les phases, la file d’envoi et les lots suivis.
L’ordre des projets et leur classement dans **Terminés** sont propres à l’appareil.
Les To-do de workspace utilisent leur stockage Paseo habituel.

Installe le répertoire avec `paseo plugin install /chemin/vers/plugins/projets` et recharge les
changements avec `paseo plugin reload projets`. Une liste vide apparaît automatiquement pour
chaque nouveau projet.

Glisse une tâche dans **À envoyer** ou ajoute-la depuis son menu. **Envoyer** lance un agent
dans l’espace choisi et place le lot **En cours**. Quand l’agent termine son premier tour, le lot
passe **À vérifier**. Coche les tâches que tu as validées. Chaque tâche reste dans sa phase.

Pour sauvegarder les listes, sauvegarde le fichier SQLite avec les données de ton daemon Paseo.

## Things sur Mac

Le tableau Dossiers peut partager ses projets avec un domaine Things. Chaque application conserve
son ordre. Les notes, les cases et les déplacements entre sections suivent les modifications. Les
images, les agents et les espaces de travail restent dans Paseo. Supprimer un projet dans Things
délie sa carte. **Relier à Things** rétablit le lien. Les modifications simultanées du même champ
se règlent dans le tableau.

Installe [things-cli](https://github.com/ryanlewis/things-cli) (version testée 0.11.0) sur le Mac
du daemon et active les URL Things dans les réglages de Things. Crée un domaine **Paseo**, récupère
son identifiant avec `things --json areas`, puis enregistre dans `$PASEO_HOME/things-sync.json` :

```json
{ "binary": "/chemin/vers/things", "area": "identifiant-du-domaine" }
```

Pour ajouter une section à un projet existant depuis Paseo, signe le raccourci
`mac/Paseo - Créer une section.shortcut` avec `shortcuts sign` et importe-le dans Raccourcis.
Ajoute son identifiant (`shortcuts list --show-identifiers`) au réglage `headingShortcut`.
macOS demande l’autorisation de transmettre le projet et le nom de section à Things.
Recharge ensuite le plugin sur le daemon configuré.

Le Mac écoute les changements de la base Things et la lit en lecture seule. Les écritures passent
par Things. Une modification du contenu d’une checklist peut renouveler les identifiants Things
de ses lignes. Paseo conserve leur correspondance et l’ordre local de chaque application.
Sauvegarde `projects-todos.sqlite3` avec le profil de Paseo Dev qui contient le tableau.
