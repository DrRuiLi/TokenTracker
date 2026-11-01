import { useCallback, useEffect, useState } from "react";
import { BUILTIN_PETS, listPets } from "../lib/pets-api.js";

let catalogCache = BUILTIN_PETS;

export function cachedPetById(id) {
  return catalogCache.find((pet) => pet.id === id) || BUILTIN_PETS[0];
}

export function usePetCatalog() {
  const [pets, setPets] = useState(catalogCache);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await listPets();
      catalogCache = next;
      setPets(next);
      setAvailable(true);
      return next;
    } catch {
      // The hosted web dashboard has no local pet API. Built-ins remain usable.
      catalogCache = BUILTIN_PETS;
      setPets(BUILTIN_PETS);
      setAvailable(false);
      return BUILTIN_PETS;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { pets, loading, available, refresh };
}
