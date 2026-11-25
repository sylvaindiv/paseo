# Projets

Projets affiche Séquence depuis la bibliothèque de Things Local sur le Mac du daemon.
Garde les sources de Things Local dans `~/Applis/Perso/Things` et Xcode sélectionné.
Le plugin compile son accès à la bibliothèque au premier usage après un rechargement.
`PASEO_THINGS_SOURCE` permet d’indiquer un autre dossier de sources.

Recharge avec `paseo plugin reload projets`. Le plugin utilise la bibliothèque
`~/Library/Application Support/Things Local/Library.sqlite`, même si Things Local
est fermé. Pour les tests, `PERSO_THINGS_DATABASE` permet de pointer le daemon
vers une bibliothèque temporaire existante.

Les captures, sous-tâches, notes et images sont enregistrées dans Things Local.
Le suivi des envois aux agents est enregistré dans `projets-sequence.sqlite3`
dans le dossier du daemon, par identifiant de tâche Things Local. Les listes
To-do des espaces gardent leur stockage Paseo.

## Coach

Le bouton **Coach** ouvre un fil conservé sur le daemon. Il propose un planning à
partir de Séquence et de l’agenda de Things Local. **Valider le planning** applique
le brouillon affiché. Le bilan et la saison s’enregistrent dans Projets après
confirmation. La revue distingue les réservations, les tâches terminées et les
bilans déclarés.

Le daemon utilise le lanceur `Tools/paseo-planning` de Things Local et
l’application `Planning Things Local.app` dans `~/Library/Application Support/Things Local`.
`PASEO_THINGS_PLANNING_APP` permet d’indiquer un autre emplacement pour
l’application. Le Coach aide à prioriser les tâches quand l’agenda est
inaccessible. Les horaires proposés se valident quand l’accès est disponible.

Things vérifie les créneaux et les versions des blocs à l’écriture. Le Coach
conserve le même identifiant de demande en cas de réponse interrompue. Si
Things signale un conflit, le Coach relit l’agenda et soumet un autre brouillon.
