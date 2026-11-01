-- Aliases belong to their machine slot and must not block account deletion.
ALTER TABLE public.tokentracker_cloud_machine_aliases
  DROP CONSTRAINT tokentracker_cloud_machine_al_user_id_environment_machine__fkey,
  ADD CONSTRAINT tokentracker_cloud_machine_al_user_id_environment_machine__fkey
    FOREIGN KEY (user_id, environment, machine_id)
    REFERENCES public.tokentracker_cloud_machines(user_id, environment, id)
    ON DELETE CASCADE;
