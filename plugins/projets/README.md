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
