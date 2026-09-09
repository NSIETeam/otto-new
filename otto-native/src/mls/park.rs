//! Park-authorized MLS generations. Direct enterprise sessions stay unchanged.
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, SerdeSerialize, SerdeDeserialize)]
#[serde(deny_unknown_fields)]
pub struct ParkAuthority {
    pub park_id: String,
    pub conversation_id: String,
    pub generation: u64,
    pub members: Vec<String>,
}
#[derive(Clone, SerdeSerialize, SerdeDeserialize)]
#[serde(deny_unknown_fields)]
pub struct ParkPackage {
    pub device_scope: String,
    pub reference: String,
    pub key_package: String,
}
impl ParkPackage {
    #[cfg(test)]
    fn new(scope: &str, package: &ExportedKeyPackage) -> Self {
        Self {
            device_scope: scope.into(),
            reference: package.reference.clone(),
            key_package: package.key_package.clone(),
        }
    }
}
#[derive(Clone, SerdeSerialize, SerdeDeserialize)]
pub struct ParkInvitation {
    pub group_id: String,
    pub welcome: String,
}
#[derive(Clone, SerdeSerialize, SerdeDeserialize)]
pub struct ParkEncrypted {
    pub group_id: String,
    pub epoch: u64,
    pub ciphertext: String,
}
#[derive(Clone, SerdeSerialize, SerdeDeserialize)]
struct Generation {
    authority: ParkAuthority,
    group_id: String,
    retired: bool,
    invitation: Option<ParkInvitation>,
}
#[derive(Clone, SerdeSerialize, SerdeDeserialize)]
struct CachedMessage {
    key: String,
    event_id: String,
    plaintext: String,
    sender: String,
    ciphertext: String,
    group_id: String,
    epoch: u64,
}
#[derive(Default, SerdeSerialize, SerdeDeserialize)]
#[serde(deny_unknown_fields)]
struct ParkMetadata {
    generations: Vec<Generation>,
    messages: Vec<CachedMessage>,
}
#[derive(Default)]
pub struct ParkMlsKernel {
    base: MlsKernel,
    groups: HashMap<String, MlsGroup>,
    metadata: ParkMetadata,
    scope: String,
}
const PARK_METADATA_KEY: &[u8] = b"otto/park-mls/generation-metadata/v1";
fn generation_key(authority: &ParkAuthority) -> String {
    serde_json::to_string(&(
        authority.park_id.as_str(),
        authority.conversation_id.as_str(),
        authority.generation,
    ))
    .expect("tuple serialization is infallible")
}
fn park_aad(authority: &ParkAuthority, event_id: &str) -> Vec<u8> {
    format!(
        "otto-park-mls-v1/{}/{}/{}/{}/{}",
        authority.park_id,
        authority.conversation_id,
        authority.generation,
        authority.members.join("|"),
        event_id
    )
    .into_bytes()
}
fn credential_scope(credential: &Credential) -> Result<String, String> {
    if credential.credential_type() != CredentialType::Basic {
        return Err("Park MLS requires a Basic device credential".into());
    }
    validate_scope(
        std::str::from_utf8(credential.serialized_content())
            .map_err(|_| "Invalid park credential")?,
    )
}
fn validate_authority(mut authority: ParkAuthority, local: &str) -> Result<ParkAuthority, String> {
    validate_conversation_id(&authority.park_id)?;
    validate_conversation_id(&authority.conversation_id)?;
    if authority.generation == 0 || authority.members.len() < 2 || authority.members.len() > 100 {
        return Err("Invalid park generation or device count".into());
    }
    let mut unique = HashSet::new();
    let mut accounts = HashSet::new();
    for member in &authority.members {
        let scope = validate_scope(member)?;
        if scope.split('/').next() != local.split('/').next() || !unique.insert(scope.clone()) {
            return Err("Park roster contains a foreign server or duplicate device".into());
        }
        accounts.insert(scope.split('/').take(3).collect::<Vec<_>>().join("/"));
    }
    if !unique.contains(local) || accounts.len() < 2 || accounts.len() > 4 {
        return Err("Park roster must authorize this device and 2 to 4 accounts".into());
    }
    authority.members.sort();
    Ok(authority)
}
fn check_members(group: &MlsGroup, authority: &ParkAuthority) -> Result<(), String> {
    let mut actual = group
        .members()
        .map(|member| credential_scope(&member.credential))
        .collect::<Result<Vec<_>, _>>()?;
    actual.sort();
    if actual != authority.members {
        return Err("Park MLS leaf roster differs from authorized devices".into());
    }
    Ok(())
}
impl ParkMlsKernel {
    pub fn initialize(
        &mut self,
        scope: &str,
        key: &str,
        snapshot: Option<&str>,
    ) -> Result<(), String> {
        if !self.scope.is_empty() {
            return Err("Park MLS already initialized".into());
        }
        self.base.configure_persistence(scope, key)?;
        if let Some(snapshot) = snapshot {
            self.base.restore_encrypted_state(scope, snapshot)?;
            if !self.base.groups.is_empty() {
                return Err("Enterprise direct snapshot cannot be used as a park snapshot".into());
            }
            let bytes = self
                .base
                .provider
                .storage()
                .values
                .read()
                .map_err(|_| "Park storage unavailable")?
                .get(PARK_METADATA_KEY)
                .cloned()
                .ok_or("Park snapshot metadata missing")?;
            self.metadata =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid park snapshot metadata")?;
            if self.metadata.generations.len() > MAX_CONVERSATIONS
                || self.metadata.messages.len() > 5000
            {
                return Err("Park snapshot exceeds limits".into());
            }
            for entry in &self.metadata.generations {
                let authority = validate_authority(entry.authority.clone(), scope)?;
                if authority != entry.authority {
                    return Err("Non-canonical park authority".into());
                }
                let group_id = decode_base64("Park group id", &entry.group_id, 128)?;
                let group = MlsGroup::load(
                    self.base.provider.storage(),
                    &GroupId::from_slice(&group_id),
                )
                .map_err(|_| "Park group restore failed")?
                .ok_or("Park group state missing")?;
                check_members(&group, &authority)?;
                if self
                    .groups
                    .insert(generation_key(&authority), group)
                    .is_some()
                {
                    return Err("Duplicate park generation".into());
                }
            }
        } else {
            self.base.initialize(scope)?;
        }
        self.scope = validate_scope(scope)?;
        Ok(())
    }
    pub fn export(&self) -> Result<String, String> {
        let bytes =
            serde_json::to_vec(&self.metadata).map_err(|_| "Park metadata serialization failed")?;
        self.base
            .provider
            .storage()
            .values
            .write()
            .map_err(|_| "Park storage unavailable")?
            .insert(PARK_METADATA_KEY.to_vec(), bytes);
        self.base.export_encrypted_state(&self.scope)
    }
    pub fn key_package(&mut self) -> Result<ExportedKeyPackage, String> {
        self.base.create_key_package(&self.scope.clone())
    }
    pub fn list_key_packages(&self) -> Result<Vec<ExportedKeyPackage>, String> {
        self.base.list_key_packages(&self.scope)
    }
    fn retire_older(&mut self, authority: &ParkAuthority) {
        for entry in &mut self.metadata.generations {
            if entry.authority.park_id == authority.park_id
                && entry.authority.conversation_id == authority.conversation_id
                && entry.authority.generation < authority.generation
            {
                entry.retired = true;
            }
        }
    }
    fn ensure_new(&self, authority: &ParkAuthority) -> Result<(), String> {
        if self.groups.len() >= MAX_CONVERSATIONS {
            return Err("Park generation limit reached".into());
        }
        if self.metadata.generations.iter().any(|entry| {
            entry.authority.park_id == authority.park_id
                && entry.authority.conversation_id == authority.conversation_id
                && entry.authority.generation >= authority.generation
        }) {
            return Err("Park generation already exists or is obsolete".into());
        }
        Ok(())
    }
    pub fn create(
        &mut self,
        raw: ParkAuthority,
        packages: Vec<ParkPackage>,
    ) -> Result<ParkInvitation, String> {
        let authority = validate_authority(raw, &self.scope)?;
        let key = generation_key(&authority);
        if let Some(entry) = self
            .metadata
            .generations
            .iter()
            .find(|entry| entry.authority == authority)
        {
            return entry
                .invitation
                .clone()
                .ok_or("Only the creator can retry initialization".into());
        }
        self.ensure_new(&authority)?;
        if packages.len() + 1 != authority.members.len() {
            return Err("Park KeyPackages do not cover the full roster".into());
        }
        let mut scopes = HashSet::from([self.scope.clone()]);
        let mut verified = Vec::new();
        for package in packages {
            let bytes = decode_base64(
                "Park KeyPackage",
                &package.key_package,
                MAX_KEY_PACKAGE_BASE64,
            )?;
            let kp = KeyPackageIn::tls_deserialize_exact(bytes)
                .map_err(|_| "Invalid park KeyPackage")?
                .validate(self.base.provider.crypto(), ProtocolVersion::Mls10)
                .map_err(|_| "Park KeyPackage signature verification failed")?;
            let scope = credential_scope(kp.leaf_node().credential())?;
            if scope != package.device_scope
                || !authority.members.contains(&scope)
                || !scopes.insert(scope)
                || kp.ciphersuite() != CIPHERSUITE
            {
                return Err("Park KeyPackage is not bound to an authorized device".into());
            }
            let reference = hex::encode(
                kp.hash_ref(self.base.provider.crypto())
                    .map_err(|_| "Park KeyPackage reference failed")?
                    .as_slice(),
            );
            if reference != package.reference {
                return Err("Park KeyPackage reference mismatch".into());
            }
            verified.push(kp);
        }
        let identity = self.base.identity.as_ref().ok_or("Park identity missing")?;
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(CIPHERSUITE)
            .use_ratchet_tree_extension(true)
            .build();
        let mut group = MlsGroup::new(
            &self.base.provider,
            &identity.signer,
            &config,
            identity.credential_with_key.clone(),
        )
        .map_err(|e| format!("Park group creation failed: {e}"))?;
        let (_, welcome, _) = group
            .add_members(&self.base.provider, &identity.signer, &verified)
            .map_err(|e| format!("Park roster commit failed: {e}"))?;
        let invitation = ParkInvitation {
            group_id: BASE64.encode(group.group_id().as_slice()),
            welcome: BASE64.encode(
                welcome
                    .to_bytes()
                    .map_err(|_| "Park Welcome serialization failed")?,
            ),
        };
        group
            .merge_pending_commit(&self.base.provider)
            .map_err(|_| "Park roster merge failed")?;
        check_members(&group, &authority)?;
        self.retire_older(&authority);
        self.metadata.generations.push(Generation {
            authority,
            group_id: invitation.group_id.clone(),
            retired: false,
            invitation: Some(invitation.clone()),
        });
        self.groups.insert(key, group);
        Ok(invitation)
    }
    pub fn join(
        &mut self,
        raw: ParkAuthority,
        reference: &str,
        expected_group_id: &str,
        encoded_welcome: &str,
    ) -> Result<(), String> {
        let authority = validate_authority(raw, &self.scope)?;
        self.ensure_new(&authority)?;
        if !self.base.available_key_packages.contains_key(reference) {
            return Err("Park KeyPackage missing or already consumed".into());
        }
        let bytes = decode_base64("Park Welcome", encoded_welcome, MAX_WELCOME_BASE64)?;
        let welcome = match MlsMessageIn::tls_deserialize_exact(bytes)
            .map_err(|_| "Invalid park Welcome")?
            .extract()
        {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            _ => return Err("Expected park Welcome".into()),
        };
        if !welcome
            .secrets()
            .iter()
            .any(|secret| hex::encode(secret.new_member().as_slice()) == reference)
        {
            return Err("Park Welcome does not consume the declared KeyPackage".into());
        }
        let config = MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .build();
        let staged = StagedWelcome::new_from_welcome(&self.base.provider, &config, welcome, None)
            .map_err(|e| format!("Park Welcome staging failed: {e}"))?;
        self.base.available_key_packages.remove(reference);
        if BASE64.encode(staged.group_context().group_id().as_slice()) != expected_group_id
            || staged.group_context().ciphersuite() != CIPHERSUITE
        {
            return Err("Park Welcome group identity mismatch".into());
        }
        let mut actual = staged
            .members()
            .map(|m| credential_scope(&m.credential))
            .collect::<Result<Vec<_>, _>>()?;
        actual.sort();
        if actual != authority.members {
            return Err("Park Welcome roster differs from authority".into());
        }
        let group = staged
            .into_group(&self.base.provider)
            .map_err(|_| "Park Welcome join failed")?;
        let key = generation_key(&authority);
        self.retire_older(&authority);
        self.metadata.generations.push(Generation {
            authority,
            group_id: expected_group_id.into(),
            retired: false,
            invitation: None,
        });
        self.groups.insert(key, group);
        Ok(())
    }
    pub fn encrypt(
        &mut self,
        raw: &ParkAuthority,
        event_id: &str,
        plaintext: &str,
    ) -> Result<ParkEncrypted, String> {
        let authority = validate_authority(raw.clone(), &self.scope)?;
        validate_conversation_id(event_id)?;
        if plaintext.is_empty() || plaintext.len() > 16 * 1024 {
            return Err("Park message size invalid".into());
        }
        let key = generation_key(&authority);
        let entry = self
            .metadata
            .generations
            .iter()
            .find(|g| g.authority == authority)
            .ok_or("Park generation is not available")?;
        if entry.retired {
            return Err("Park generation is retired for sending".into());
        }
        if let Some(message) = self
            .metadata
            .messages
            .iter()
            .find(|m| m.key == key && m.event_id == event_id)
        {
            if message.sender != self.scope || message.plaintext != plaintext {
                return Err("Park message id was reused for different content".into());
            }
            return Ok(ParkEncrypted {
                group_id: message.group_id.clone(),
                epoch: message.epoch,
                ciphertext: message.ciphertext.clone(),
            });
        }
        if self.metadata.messages.len() >= 5000 {
            return Err("Park encrypted history limit reached".into());
        }
        let identity = self.base.identity.as_ref().ok_or("Park identity missing")?;
        let group = self.groups.get_mut(&key).ok_or("Park group missing")?;
        group.set_aad(park_aad(&authority, event_id));
        let message = group
            .create_message(&self.base.provider, &identity.signer, plaintext.as_bytes())
            .map_err(|e| format!("Park encryption failed: {e}"))?;
        let encrypted = ParkEncrypted {
            group_id: BASE64.encode(group.group_id().as_slice()),
            epoch: group.epoch().as_u64(),
            ciphertext: BASE64.encode(
                message
                    .to_bytes()
                    .map_err(|_| "Park ciphertext serialization failed")?,
            ),
        };
        self.metadata.messages.push(CachedMessage {
            key,
            event_id: event_id.into(),
            plaintext: plaintext.into(),
            sender: self.scope.clone(),
            ciphertext: encrypted.ciphertext.clone(),
            group_id: encrypted.group_id.clone(),
            epoch: encrypted.epoch,
        });
        Ok(encrypted)
    }
    pub fn decrypt(
        &mut self,
        raw: &ParkAuthority,
        event_id: &str,
        expected_sender: &str,
        ciphertext: &str,
    ) -> Result<String, String> {
        let authority = validate_authority(raw.clone(), &self.scope)?;
        validate_conversation_id(event_id)?;
        if !authority.members.iter().any(|m| m == expected_sender) {
            return Err("Park message sender is not authorized".into());
        }
        let key = generation_key(&authority);
        if !self
            .metadata
            .generations
            .iter()
            .any(|g| g.authority == authority)
        {
            return Err("Park generation is not available".into());
        }
        if let Some(message) = self
            .metadata
            .messages
            .iter()
            .find(|m| m.key == key && m.event_id == event_id)
        {
            return if message.sender == expected_sender && message.ciphertext == ciphertext {
                Ok(message.plaintext.clone())
            } else {
                Err("Park message replay binding mismatch".into())
            };
        }
        if self.metadata.messages.len() >= 5000 {
            return Err("Park encrypted history limit reached".into());
        }
        let bytes = decode_base64("Park ciphertext", ciphertext, MAX_CIPHERTEXT_BASE64)?;
        let message = MlsMessageIn::tls_deserialize_exact(bytes)
            .map_err(|_| "Invalid park ciphertext")?
            .try_into_protocol_message()
            .map_err(|_| "Invalid park application type")?;
        let group = self.groups.get_mut(&key).ok_or("Park group missing")?;
        let processed = catch_unwind(AssertUnwindSafe(|| {
            group.process_message(&self.base.provider, message)
        }));
        let processed = match processed {
            Ok(Ok(value)) => value,
            Ok(Err(e)) => return Err(format!("Park decryption failed: {e}")),
            Err(_) => {
                self.groups.remove(&key);
                self.metadata
                    .generations
                    .retain(|g| generation_key(&g.authority) != key);
                return Err("Park group quarantined after malformed ciphertext".into());
            }
        };
        if processed.aad() != park_aad(&authority, event_id)
            || credential_scope(processed.credential())? != expected_sender
        {
            return Err("Park authenticated sender or message binding mismatch".into());
        }
        let group_id = BASE64.encode(processed.group_id().as_slice());
        let epoch = processed.epoch().as_u64();
        let plaintext = match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(value) => {
                String::from_utf8(value.into_bytes()).map_err(|_| "Park plaintext is not UTF-8")?
            }
            _ => return Err("Park generation does not accept membership commits".into()),
        };
        self.metadata.messages.push(CachedMessage {
            key,
            event_id: event_id.into(),
            plaintext: plaintext.clone(),
            sender: expected_sender.into(),
            ciphertext: ciphertext.into(),
            group_id,
            epoch,
        });
        Ok(plaintext)
    }
}

impl ParkMlsKernel {
    pub fn rpc(
        &mut self,
        method: &str,
        p: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let string = |key: &str| {
            p[key]
                .as_str()
                .ok_or_else(|| format!("Missing park parameter {key}"))
        };
        match method {
            "park_mls.initialize" => {
                self.initialize(
                    string("device_scope")?,
                    string("state_key")?,
                    p["encrypted_state"].as_str(),
                )?;
                Ok(serde_json::json!({"ok":true}))
            }
            "park_mls.export" => Ok(serde_json::json!({"encrypted_state":self.export()?})),
            "park_mls.key_package" => {
                serde_json::to_value(self.key_package()?).map_err(|e| e.to_string())
            }
            "park_mls.key_packages" => {
                let packages = self.list_key_packages()?;
                let values = packages
                    .into_iter()
                    .map(|package| {
                        let publishable = self
                            .base
                            .available_key_packages
                            .get(&package.reference)
                            .is_some_and(|value| value.life_time().is_valid());
                        let mut value = serde_json::to_value(package).map_err(|e| e.to_string())?;
                        value["publishable"] = serde_json::json!(publishable);
                        Ok(value)
                    })
                    .collect::<Result<Vec<serde_json::Value>, String>>()?;
                Ok(serde_json::json!(values))
            }
            "park_mls.retain_conversations" => {
                let ids: Vec<String> = serde_json::from_value(p["conversation_ids"].clone())
                    .map_err(|_| "Invalid retained conversations")?;
                if ids.len() > MAX_CONVERSATIONS {
                    return Err("Too many retained conversations".into());
                }
                let retained: HashSet<String> = ids.into_iter().collect();
                let expired: Vec<String> = self
                    .metadata
                    .generations
                    .iter()
                    .filter(|g| !retained.contains(&g.authority.conversation_id))
                    .map(|g| generation_key(&g.authority))
                    .collect();
                for key in &expired {
                    if let Some(group) = self.groups.get_mut(key) {
                        group
                            .delete(self.base.provider.storage())
                            .map_err(|_| "Expired group secret deletion failed")?;
                    }
                    self.groups.remove(key);
                }
                self.metadata
                    .generations
                    .retain(|g| retained.contains(&g.authority.conversation_id));
                self.metadata
                    .messages
                    .retain(|message| !expired.contains(&message.key));
                Ok(serde_json::json!({"ok":true}))
            }
            "park_mls.retire_packages" => {
                use openmls_traits::storage::StorageProvider;
                let references: Vec<String> = serde_json::from_value(p["references"].clone())
                    .map_err(|_| "Invalid package references")?;
                if references.len() > MAX_AVAILABLE_KEY_PACKAGES {
                    return Err("Too many package references".into());
                }
                for reference in references {
                    if let Some(package) = self.base.available_key_packages.get(&reference) {
                        let hash = package
                            .hash_ref(self.base.provider.crypto())
                            .map_err(|_| "Package reference failed")?;
                        self.base
                            .provider
                            .storage()
                            .delete_key_package(&hash)
                            .map_err(|_| "Package private material deletion failed")?;
                        self.base.available_key_packages.remove(&reference);
                    }
                }
                Ok(serde_json::json!({"ok":true}))
            }
            "park_mls.inspect" => Ok(serde_json::json!({"generations":self.metadata.generations})),
            "park_mls.history" => {
                let authority: ParkAuthority = serde_json::from_value(p["authority"].clone())
                    .map_err(|_| "Invalid park authority")?;
                let authority = validate_authority(authority, &self.scope)?;
                let key = generation_key(&authority);
                if !self
                    .metadata
                    .generations
                    .iter()
                    .any(|g| g.authority == authority)
                {
                    return Err("Park authority not available".into());
                }
                Ok(
                    serde_json::json!({"messages":self.metadata.messages.iter().filter(|m|m.key==key).collect::<Vec<_>>()}),
                )
            }
            "park_mls.create" => {
                let authority = serde_json::from_value(p["authority"].clone())
                    .map_err(|_| "Invalid park authority")?;
                let packages = serde_json::from_value(p["packages"].clone())
                    .map_err(|_| "Invalid park packages")?;
                serde_json::to_value(self.create(authority, packages)?).map_err(|e| e.to_string())
            }
            "park_mls.join" => {
                let authority = serde_json::from_value(p["authority"].clone())
                    .map_err(|_| "Invalid park authority")?;
                self.join(
                    authority,
                    string("reference")?,
                    string("group_id")?,
                    string("welcome")?,
                )?;
                Ok(serde_json::json!({"ok":true}))
            }
            "park_mls.encrypt" => {
                let authority = serde_json::from_value(p["authority"].clone())
                    .map_err(|_| "Invalid park authority")?;
                serde_json::to_value(self.encrypt(
                    &authority,
                    string("event_id")?,
                    string("plaintext")?,
                )?)
                .map_err(|e| e.to_string())
            }
            "park_mls.decrypt" => {
                let authority = serde_json::from_value(p["authority"].clone())
                    .map_err(|_| "Invalid park authority")?;
                Ok(
                    serde_json::json!({"plaintext":self.decrypt(&authority,string("event_id")?,string("sender")?,string("ciphertext")?)? }),
                )
            }
            _ => Err("Unknown park MLS method".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn device(scope: &str) -> ParkMlsKernel {
        let mut kernel = ParkMlsKernel::default();
        kernel
            .initialize(scope, &BASE64.encode([31u8; 32]), None)
            .unwrap();
        kernel
    }
    fn authority(generation: u64, members: &[&str]) -> ParkAuthority {
        ParkAuthority {
            park_id: "park-a".into(),
            conversation_id: "park-conversation-a".into(),
            generation,
            members: members.iter().map(|m| m.to_string()).collect(),
        }
    }
    #[test]
    fn expired_native_packages_are_not_advertised_as_publishable_but_keep_welcome_keys() {
        let mut kernel = device("server-a/org-a/alice/a1");
        let identity = kernel.base.identity.as_ref().unwrap();
        let bundle = KeyPackage::builder()
            .key_package_lifetime(openmls::prelude::Lifetime::init(1, 2))
            .build(
                CIPHERSUITE,
                &kernel.base.provider,
                &identity.signer,
                identity.credential_with_key.clone(),
            )
            .unwrap();
        let package = bundle.key_package().clone();
        let reference = hex::encode(
            package
                .hash_ref(kernel.base.provider.crypto())
                .unwrap()
                .as_slice(),
        );
        kernel
            .base
            .available_key_packages
            .insert(reference.clone(), package);
        let inventory = kernel
            .rpc("park_mls.key_packages", &serde_json::json!({}))
            .unwrap();
        assert_eq!(inventory[0]["publishable"], false);
        assert!(kernel.base.available_key_packages.contains_key(&reference));
    }
    #[test]
    fn maintenance_deletes_expired_group_secrets_and_cached_plaintext() {
        let a = "server-a/org-a/alice/a1";
        let b = "server-a/org-b/bob/b1";
        let mut alice = device(a);
        let mut bob = device(b);
        let auth = authority(1, &[a, b]);
        let bp = bob.key_package().unwrap();
        let invitation = alice
            .create(auth.clone(), vec![ParkPackage::new(b, &bp)])
            .unwrap();
        alice
            .encrypt(&auth, "retention-message", "sensitive history")
            .unwrap();
        alice
            .rpc(
                "park_mls.retain_conversations",
                &serde_json::json!({"conversation_ids":[]}),
            )
            .unwrap();
        assert!(alice.metadata.messages.is_empty());
        assert!(alice.metadata.generations.is_empty());
        assert!(alice.groups.is_empty());
        let group_id = decode_base64("id", &invitation.group_id, 128).unwrap();
        assert!(MlsGroup::load(
            alice.base.provider.storage(),
            &GroupId::from_slice(&group_id)
        )
        .unwrap()
        .is_none());
        assert!(alice
            .encrypt(&auth, "after-retention", "cannot resurrect")
            .is_err());
    }
    #[test]
    fn retiring_packages_removes_private_material_and_releases_inventory() {
        use openmls_traits::storage::StorageProvider;
        let mut kernel = device("server-a/org-a/alice/a1");
        let package = kernel.key_package().unwrap();
        let hash = kernel.base.available_key_packages[&package.reference]
            .hash_ref(kernel.base.provider.crypto())
            .unwrap();
        kernel
            .rpc(
                "park_mls.retire_packages",
                &serde_json::json!({"references":[package.reference]}),
            )
            .unwrap();
        assert!(kernel.list_key_packages().unwrap().is_empty());
        let stored: Option<openmls::prelude::KeyPackageBundle> =
            kernel.base.provider.storage().key_package(&hash).unwrap();
        assert!(stored.is_none());
        for _ in 0..110 {
            let package = kernel.key_package().unwrap();
            kernel
                .rpc(
                    "park_mls.retire_packages",
                    &serde_json::json!({"references":[package.reference]}),
                )
                .unwrap();
        }
        assert!(kernel.list_key_packages().unwrap().is_empty());
    }
    #[test]
    fn cross_company_three_accounts_four_devices_use_real_mls_and_isolate_generations() {
        let a = "server-a/org-a/alice/a1";
        let a2 = "server-a/org-a/alice/a2";
        let b = "server-a/org-b/bob/b1";
        let c = "server-a/org-c/carol/c1";
        let mut alice = device(a);
        let mut alice2 = device(a2);
        let mut bob = device(b);
        let mut carol = device(c);
        let first = authority(1, &[a, b]);
        let bp = bob.key_package().unwrap();
        let invitation = alice
            .create(first.clone(), vec![ParkPackage::new(b, &bp)])
            .unwrap();
        bob.join(
            first.clone(),
            &bp.reference,
            &invitation.group_id,
            &invitation.welcome,
        )
        .unwrap();
        let old = alice
            .encrypt(&first, "message-1", "before carol joined")
            .unwrap();
        assert_eq!(
            bob.decrypt(&first, "message-1", a, &old.ciphertext)
                .unwrap(),
            "before carol joined"
        );
        let second = authority(2, &[a, a2, b, c]);
        let ap = alice2.key_package().unwrap();
        let bp = bob.key_package().unwrap();
        let cp = carol.key_package().unwrap();
        let invitation = alice
            .create(
                second.clone(),
                vec![
                    ParkPackage::new(a2, &ap),
                    ParkPackage::new(b, &bp),
                    ParkPackage::new(c, &cp),
                ],
            )
            .unwrap();
        alice2
            .join(
                second.clone(),
                &ap.reference,
                &invitation.group_id,
                &invitation.welcome,
            )
            .unwrap();
        bob.join(
            second.clone(),
            &bp.reference,
            &invitation.group_id,
            &invitation.welcome,
        )
        .unwrap();
        carol
            .join(
                second.clone(),
                &cp.reference,
                &invitation.group_id,
                &invitation.welcome,
            )
            .unwrap();
        assert!(carol
            .decrypt(&first, "message-1", a, &old.ciphertext)
            .is_err());
        let shared = alice
            .encrypt(&second, "message-2", "four devices, three people")
            .unwrap();
        assert_eq!(
            carol
                .decrypt(&second, "message-2", a, &shared.ciphertext)
                .unwrap(),
            "four devices, three people"
        );
        assert_eq!(
            bob.decrypt(&second, "message-2", a, &shared.ciphertext)
                .unwrap(),
            "four devices, three people"
        );
        assert_eq!(
            alice2
                .decrypt(&second, "message-2", a, &shared.ciphertext)
                .unwrap(),
            "four devices, three people"
        );
        let third = authority(3, &[a, c]);
        let cp = carol.key_package().unwrap();
        let invitation = alice
            .create(third.clone(), vec![ParkPackage::new(c, &cp)])
            .unwrap();
        carol
            .join(
                third.clone(),
                &cp.reference,
                &invitation.group_id,
                &invitation.welcome,
            )
            .unwrap();
        let after = alice
            .encrypt(&third, "message-3", "after bob left")
            .unwrap();
        assert!(bob
            .decrypt(&third, "message-3", a, &after.ciphertext)
            .is_err());
        assert_eq!(
            carol
                .decrypt(&third, "message-3", a, &after.ciphertext)
                .unwrap(),
            "after bob left"
        );
        assert!(alice
            .encrypt(&second, "stale-message", "must not send")
            .is_err());
    }
    #[test]
    fn exact_roster_binding_persistence_and_replay_are_enforced() {
        let a = "server-a/org-a/alice/a1";
        let b = "server-a/org-b/bob/b1";
        let c = "server-a/org-c/carol/c1";
        let mut alice = device(a);
        let mut bob = device(b);
        let mut carol = device(c);
        let auth = authority(1, &[a, b]);
        let bp = bob.key_package().unwrap();
        let cp = carol.key_package().unwrap();
        assert!(alice
            .create(auth.clone(), vec![ParkPackage::new(b, &cp)])
            .is_err());
        let invitation = alice
            .create(auth.clone(), vec![ParkPackage::new(b, &bp)])
            .unwrap();
        assert!(bob
            .join(
                authority(1, &[a, b, c]),
                &bp.reference,
                &invitation.group_id,
                &invitation.welcome
            )
            .is_err());
        // A failed Welcome consumes its one-time package; a fresh generation is needed.
        assert!(bob
            .join(
                auth.clone(),
                &bp.reference,
                &invitation.group_id,
                &invitation.welcome
            )
            .is_err());
        let auth = authority(2, &[a, b]);
        let bp = bob.key_package().unwrap();
        let invitation = alice
            .create(auth.clone(), vec![ParkPackage::new(b, &bp)])
            .unwrap();
        bob.join(
            auth.clone(),
            &bp.reference,
            &invitation.group_id,
            &invitation.welcome,
        )
        .unwrap();
        let message = alice
            .encrypt(&auth, "persisted-message", "persisted securely")
            .unwrap();
        let snapshot = alice.export().unwrap();
        assert!(!snapshot.contains("persisted securely"));
        let mut restored = ParkMlsKernel::default();
        restored
            .initialize(a, &BASE64.encode([31u8; 32]), Some(&snapshot))
            .unwrap();
        assert_eq!(
            restored
                .encrypt(&auth, "persisted-message", "persisted securely")
                .unwrap()
                .ciphertext,
            message.ciphertext
        );
        assert!(restored
            .encrypt(&auth, "persisted-message", "changed message")
            .is_err());
        assert_eq!(
            bob.decrypt(&auth, "persisted-message", a, &message.ciphertext)
                .unwrap(),
            "persisted securely"
        );
        assert!(bob
            .decrypt(&auth, "forged-message", c, &message.ciphertext)
            .is_err());
        let rpc=bob.rpc("park_mls.decrypt",&serde_json::json!({"authority":auth,"event_id":"persisted-message","sender":a,"ciphertext":message.ciphertext})).unwrap();
        assert_eq!(rpc["plaintext"].as_str(), Some("persisted securely"));
        assert!(bob.rpc("park_mls.decrypt",&serde_json::json!({"authority":auth,"event_id":"forged-message","sender":c,"ciphertext":message.ciphertext})).is_err());
        let mut left = auth.clone();
        left.park_id = "a:b".into();
        left.conversation_id = "c".into();
        let mut right = auth.clone();
        right.park_id = "a".into();
        right.conversation_id = "b:c".into();
        assert_ne!(generation_key(&left), generation_key(&right));
        assert!(bob
            .rpc("park_mls.history", &serde_json::json!({"authority":left}))
            .is_err());
    }
}
