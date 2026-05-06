/* Chogi Pet Sprite Resolver
   Returns the correct character PNG path for the player's active pet.
   Falls back to a per-game default if no pet is hatched.

   Usage in a game:
     <script src="/js/pet-store.js"></script>
     <script src="/js/pet-sprite.js"></script>
     <script>
       var spriteUrl = ChogiSprite.resolve('/pet-assets/adult-feral-chogi.png');
       var img = new Image();
       img.src = spriteUrl;
     </script>
*/
(function(){
  if(window.ChogiSprite) return;

  function spriteFor(pet){
    if(!pet) return null;
    var type = pet.type === 'chog' ? 'chog' : 'chogi';
    var stage = pet.stage || 'baby';
    if(stage === 'adult'){
      var p = pet.personality || 'loyal';
      // valid personalities: loyal, chaotic, glutton, feral, prime
      var ok = ['loyal','chaotic','glutton','feral','prime'].indexOf(p) !== -1;
      if(!ok) p = 'loyal';
      return '/pet-assets/adult-' + p + '-' + type + '.png';
    }
    if(stage === 'teen') return '/pet-assets/teen-' + type + '.png';
    if(stage === 'kid')  return '/pet-assets/kid-' + type + '.png';
    return '/pet-assets/baby-' + type + '.png';
  }

  function getActivePet(){
    if(!window.ChogiPetStore) return null;
    try {
      var id = window.ChogiPetStore.getActivePetId();
      if(!id) return null;
      return window.ChogiPetStore.getLocal(id);
    } catch(e){
      return null;
    }
  }

  // Returns sprite URL for active pet, or fallback if no pet found.
  // Pass the fallback as either a URL string or a {chogi: url, chog: url} object.
  function resolve(fallback){
    var pet = getActivePet();
    var url = spriteFor(pet);
    if(url) return url;
    if(typeof fallback === 'object' && fallback){
      return fallback.chogi || fallback.chog || null;
    }
    return fallback || null;
  }

  // Returns metadata so games can adapt UI (e.g. "Playing as: KING'S CHOGI · ADULT FERAL")
  function info(){
    var pet = getActivePet();
    if(!pet) return { hasPet: false };
    return {
      hasPet: true,
      petId: pet.pet_id,
      name: pet.name || 'unnamed',
      type: pet.type === 'chog' ? 'chog' : 'chogi',
      stage: pet.stage || 'baby',
      personality: pet.personality || null,
      sprite: spriteFor(pet)
    };
  }

  window.ChogiSprite = { resolve: resolve, info: info, spriteFor: spriteFor };
})();
