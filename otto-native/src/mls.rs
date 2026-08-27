use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::RustCrypto;
use openmls_sqlite_storage::{Codec, SqliteStorageProvider};
use openmls_traits::{signatures::Signer, types::SignatureScheme, OpenMlsProvider};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{serialize::OwnedData, Connection, DatabaseName};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    ptr::NonNull,
    rc::Rc,
};
use tempfile::NamedTempFile;
use zeroize::Zeroizing;

const SNAPSHOT_VERSION: u32 = 1;
const STATE_AAD_LABEL: &[u8] = b"otto:openmls-state:v1";
const GROUP_ID_LABEL: &[u8] = b"otto:openmls-group:v1";
const MESSAGE_AAD_LABEL: &[u8] = b"otto:openmls-message:v1";
const CONTROL_AAD_LABEL: &[u8] = b"otto:openmls-control:v1";
const MAX_STATE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TEXT_FIELD_BYTES: usize = 8 * 1024;
const MAX_PLAINTEXT_BYTES: usize = 16 * 1024 * 1024;

type MlsStorage = SqliteStorageProvider<JsonCodec, Rc<Connection>>;

#[derive(Default)]
struct JsonCodec;

impl Codec for JsonCodec {
    type Error = serde_json::Error;

    fn to_vec<T: Serialize>(value: &T) -> Result<Vec<u8>, Self::Error> {
        serde_json::to_vec(value)
    }

    fn from_slice<T: DeserializeOwned>(slice: &[u8]) -> Result<T, Self::Error> {
        serde_json::from_slice(slice)
    }
}

struct OttoMlsProvider {
    crypto: RustCrypto,
    storage: MlsStorage,
}

impl OpenMlsProvider for OttoMlsProvider {
    type CryptoProvider = RustCrypto;
    type RandProvider = RustCrypto;
    type StorageProvider = MlsStorage;

    fn storage(&self) -> &Self::StorageProvider {
        &self.storage
    }

    fn crypto(&self) -> &Self::CryptoProvider {
        &self.crypto
    }

    fn rand(&self) -> &Self::RandProvider {
        &self.crypto
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EncryptedSnapshot {
    version: u32,
    nonce: String,
    ciphertext: String,
}

#[derive(Serialize)]
struct SnapshotPayloadRef<'a> {
    version: u32,
    scope: &'a str,
    identity: &'a str,
    signer: &'a SignatureKeyPair,
    sqlite: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotPayload {
    version: u32,
    scope: String,
    identity: String,
    signer: SignatureKeyPair,
    sqlite: String,
}

#[derive(Debug, Serialize)]
pub struct MlsStatus {
    pub protocol: &'static str,
    pub ciphersuite: &'static str,
    pub scope_hash: String,
    pub identity: String,
    pub public_key: String,
    pub state_path: String,
}

#[derive(Debug, Serialize)]
pub struct GeneratedKeyPackage {
    pub key_package: String,
    pub key_package_ref: String,
    pub ciphersuite: &'static str,
}

#[derive(Debug, Serialize)]
pub struct GroupResult {
    pub conversation_id: String,
    pub epoch: u64,
    pub member_count: usize,
}

#[derive(Debug, Serialize)]
pub struct AddMemberResult {
    pub commit: String,
    pub welcome: String,
    pub epoch: u64,
    pub member_count: usize,
}

#[derive(Debug, Serialize)]
pub struct EncryptedMessage {
    pub message: String,
    pub epoch: u64,
}

#[derive(Debug, Serialize)]
pub struct DecryptedMessage {
    pub plaintext: String,
    pub epoch: u64,
}

pub struct MlsEngine {
    path: PathBuf,
    key: Zeroizing<Vec<u8>>,
    scope: String,
    identity: String,
    signer: SignatureKeyPair,
    connection: Rc<Connection>,
    provider: OttoMlsProvider,
}

impl MlsEngine {
    pub fn open(
        path: String,
        key_hex: String,
        scope: String,
        identity: String,
    ) -> Result<Self, String> {
        validate_text("path", &path)?;
        validate_text("scope", &scope)?;
        validate_text("identity", &identity)?;

        let key = Zeroizing::new(
            hex::decode(&key_hex)
                .map_err(|_| "MLS state key must be 64 hexadecimal characters".to_string())?,
        );
        if key.len() != 32 {
            return Err("MLS state key must be 32 bytes".to_string());
        }

        let path = PathBuf::from(path);
        let loaded = if path.exists() {
            Some(Self::read_snapshot(&path, &key, &scope, &identity)?)
        } else {
            None
        };

        let (connection, signer) = match loaded {
            Some(payload) => {
                let sqlite = URL_SAFE_NO_PAD
                    .decode(payload.sqlite)
                    .map_err(|_| "MLS state contains invalid SQLite data".to_string())?;
                (deserialize_connection(sqlite)?, payload.signer)
            }
            None => (
                Connection::open_in_memory()
                    .map_err(|e| format!("Failed to open MLS memory store: {e}"))?,
                SignatureKeyPair::new(SignatureScheme::ED25519)
                    .map_err(|e| format!("Failed to generate MLS signing key: {e:?}"))?,
            ),
        };

        let mut connection = connection;
        {
            let mut migrations =
                SqliteStorageProvider::<JsonCodec, &mut Connection>::new(&mut connection);
            migrations
                .run_migrations()
                .map_err(|e| format!("Failed to migrate MLS state: {e}"))?;
        }

        let connection = Rc::new(connection);
        let provider = OttoMlsProvider {
            crypto: RustCrypto::default(),
            storage: SqliteStorageProvider::new(Rc::clone(&connection)),
        };

        if loaded.is_none() {
            signer
                .store(provider.storage())
                .map_err(|e| format!("Failed to store MLS signing key: {e}"))?;
        }

        let engine = Self {
            path,
            key,
            scope,
            identity,
            signer,
            connection,
            provider,
        };
        engine.persist()?;
        Ok(engine)
    }

    pub fn status(&self) -> MlsStatus {
        MlsStatus {
            protocol: "MLS 1.0",
            ciphersuite: ciphersuite_name(),
            scope_hash: URL_SAFE_NO_PAD.encode(Sha256::digest(self.scope.as_bytes())),
            identity: self.identity.clone(),
            public_key: URL_SAFE_NO_PAD.encode(self.signer.public()),
            state_path: self.path.to_string_lossy().into_owned(),
        }
    }

    pub fn generate_key_package(&self) -> Result<GeneratedKeyPackage, String> {
        let bundle = KeyPackage::builder()
            .build(
                ciphersuite(),
                &self.provider,
                &self.signer,
                self.credential(),
            )
            .map_err(|e| format!("Failed to generate MLS KeyPackage: {e:?}"))?;
        let key_package = bundle.key_package();
        let encoded = key_package
            .tls_serialize_detached()
            .map_err(|e| format!("Failed to serialize MLS KeyPackage: {e:?}"))?;
        let reference = key_package
            .hash_ref(self.provider.crypto())
            .map_err(|e| format!("Failed to hash MLS KeyPackage: {e:?}"))?;
        self.persist()?;
        Ok(GeneratedKeyPackage {
            key_package: URL_SAFE_NO_PAD.encode(encoded),
            key_package_ref: URL_SAFE_NO_PAD.encode(reference.as_slice()),
            ciphersuite: ciphersuite_name(),
        })
    }

    pub fn create_group(&self, conversation_id: &str) -> Result<GroupResult, String> {
        validate_text("conversation_id", conversation_id)?;
        let group_id = self.group_id(conversation_id);
        if MlsGroup::load(self.provider.storage(), &group_id)
            .map_err(|e| format!("Failed to inspect MLS group: {e}"))?
            .is_some()
        {
            return Err("MLS group already exists for this conversation".to_string());
        }

        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(ciphersuite())
            .use_ratchet_tree_extension(true)
            .build();
        let group = MlsGroup::new_with_group_id(
            &self.provider,
            &self.signer,
            &config,
            group_id,
            self.credential(),
        )
        .map_err(|e| format!("Failed to create MLS group: {e:?}"))?;
        let result = group_result(conversation_id, &group);
        self.persist()?;
        Ok(result)
    }

    pub fn add_member(
        &self,
        conversation_id: &str,
        encoded_key_package: &str,
    ) -> Result<AddMemberResult, String> {
        validate_text("conversation_id", conversation_id)?;
        let bytes = decode_wire("key_package", encoded_key_package)?;
        let key_package = KeyPackageIn::tls_deserialize_exact(bytes)
            .map_err(|e| format!("Invalid MLS KeyPackage encoding: {e:?}"))?
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|e| format!("Invalid MLS KeyPackage: {e:?}"))?;

        let mut group = self.load_group(conversation_id)?;
        group.set_aad(self.control_aad(conversation_id));
        let (commit, welcome, _) = group
            .add_members(
                &self.provider,
                &self.signer,
                std::slice::from_ref(&key_package),
            )
            .map_err(|e| format!("Failed to add MLS member: {e:?}"))?;
        let commit = commit
            .to_bytes()
            .map_err(|e| format!("Failed to serialize MLS commit: {e:?}"))?;
        let welcome_message: MlsMessageIn = welcome.into();
        let welcome = welcome_message
            .tls_serialize_detached()
            .map_err(|e| format!("Failed to serialize MLS Welcome: {e:?}"))?;
        group
            .merge_pending_commit(&self.provider)
            .map_err(|e| format!("Failed to activate MLS member: {e:?}"))?;
        let result = AddMemberResult {
            commit: URL_SAFE_NO_PAD.encode(commit),
            welcome: URL_SAFE_NO_PAD.encode(welcome),
            epoch: group.epoch().as_u64(),
            member_count: group.members().count(),
        };
        self.persist()?;
        Ok(result)
    }

    pub fn join_group(
        &self,
        conversation_id: &str,
        encoded_welcome: &str,
    ) -> Result<GroupResult, String> {
        validate_text("conversation_id", conversation_id)?;
        let bytes = decode_wire("welcome", encoded_welcome)?;
        let message = MlsMessageIn::tls_deserialize_exact(bytes)
            .map_err(|e| format!("Invalid MLS Welcome encoding: {e:?}"))?;
        let welcome = message
            .into_welcome()
            .map_err(|_| "MLS message is not a Welcome".to_string())?;
        let config = MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .build();
        let staged = StagedWelcome::new_from_welcome(&self.provider, &config, welcome, None)
            .map_err(|e| format!("Failed to process MLS Welcome: {e:?}"))?;
        let mut group = staged
            .into_group(&self.provider)
            .map_err(|e| format!("Failed to join MLS group: {e:?}"))?;
        let expected_group_id = self.group_id(conversation_id);
        if group.group_id() != &expected_group_id {
            let _ = group.delete(self.provider.storage());
            return Err("MLS Welcome belongs to another conversation or account scope".to_string());
        }
        let result = group_result(conversation_id, &group);
        self.persist()?;
        Ok(result)
    }

    pub fn process_commit(
        &self,
        conversation_id: &str,
        encoded_commit: &str,
    ) -> Result<GroupResult, String> {
        validate_text("conversation_id", conversation_id)?;
        let bytes = decode_wire("commit", encoded_commit)?;
        let message = MlsMessageIn::tls_deserialize_exact(bytes)
            .map_err(|e| format!("Invalid MLS commit encoding: {e:?}"))?;
        let protocol = message
            .try_into_protocol_message()
            .map_err(|_| "MLS message is not a protocol message".to_string())?;
        let mut group = self.load_group(conversation_id)?;
        let processed = group
            .process_message(&self.provider, protocol)
            .map_err(|e| format!("Failed to process MLS commit: {e:?}"))?;
        if processed.aad() != self.control_aad(conversation_id) {
            return Err(
                "MLS commit authenticated data does not match this conversation".to_string(),
            );
        }
        match processed.into_content() {
            ProcessedMessageContent::StagedCommitMessage(staged_commit) => group
                .merge_staged_commit(&self.provider, *staged_commit)
                .map_err(|e| format!("Failed to merge MLS commit: {e:?}"))?,
            _ => return Err("MLS message is not a commit".to_string()),
        }
        let result = group_result(conversation_id, &group);
        self.persist()?;
        Ok(result)
    }

    pub fn encrypt(
        &self,
        conversation_id: &str,
        plaintext: &str,
        aad: &str,
    ) -> Result<EncryptedMessage, String> {
        validate_text("conversation_id", conversation_id)?;
        validate_aad(aad)?;
        if plaintext.as_bytes().len() > MAX_PLAINTEXT_BYTES {
            return Err("MLS plaintext exceeds 16 MiB".to_string());
        }
        let mut group = self.load_group(conversation_id)?;
        group.set_aad(self.message_aad(conversation_id, aad));
        let message = group
            .create_message(&self.provider, &self.signer, plaintext.as_bytes())
            .map_err(|e| format!("Failed to encrypt MLS message: {e:?}"))?;
        let bytes = message
            .to_bytes()
            .map_err(|e| format!("Failed to serialize MLS message: {e:?}"))?;
        let result = EncryptedMessage {
            message: URL_SAFE_NO_PAD.encode(bytes),
            epoch: group.epoch().as_u64(),
        };
        self.persist()?;
        Ok(result)
    }

    pub fn decrypt(
        &self,
        conversation_id: &str,
        encoded_message: &str,
        expected_aad: &str,
    ) -> Result<DecryptedMessage, String> {
        validate_text("conversation_id", conversation_id)?;
        validate_aad(expected_aad)?;
        let bytes = decode_wire("message", encoded_message)?;
        let message = MlsMessageIn::tls_deserialize_exact(bytes)
            .map_err(|e| format!("Invalid MLS message encoding: {e:?}"))?;
        let protocol = message
            .try_into_protocol_message()
            .map_err(|_| "MLS message is not an encrypted protocol message".to_string())?;
        let mut group = self.load_group(conversation_id)?;
        let processed = group
            .process_message(&self.provider, protocol)
            .map_err(|e| format!("Failed to decrypt MLS message: {e:?}"))?;
        if processed.aad() != self.message_aad(conversation_id, expected_aad) {
            return Err(
                "MLS message authenticated data does not match this conversation".to_string(),
            );
        }
        let plaintext = match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(message) => message.into_bytes(),
            _ => return Err("MLS message does not contain application data".to_string()),
        };
        let plaintext = String::from_utf8(plaintext)
            .map_err(|_| "MLS plaintext is not valid UTF-8".to_string())?;
        let result = DecryptedMessage {
            plaintext,
            epoch: group.epoch().as_u64(),
        };
        self.persist()?;
        Ok(result)
    }

    pub fn delete_group(&self, conversation_id: &str) -> Result<bool, String> {
        validate_text("conversation_id", conversation_id)?;
        let group_id = self.group_id(conversation_id);
        let Some(mut group) = MlsGroup::load(self.provider.storage(), &group_id)
            .map_err(|e| format!("Failed to load MLS group: {e}"))?
        else {
            return Ok(false);
        };
        group
            .delete(self.provider.storage())
            .map_err(|e| format!("Failed to delete MLS group: {e}"))?;
        self.persist()?;
        Ok(true)
    }

    pub fn persist(&self) -> Result<(), String> {
        let sqlite = self
            .connection
            .serialize(DatabaseName::Main)
            .map_err(|e| format!("Failed to serialize MLS state: {e}"))?
            .to_vec();
        let payload = SnapshotPayloadRef {
            version: SNAPSHOT_VERSION,
            scope: &self.scope,
            identity: &self.identity,
            signer: &self.signer,
            sqlite: URL_SAFE_NO_PAD.encode(sqlite),
        };
        let plaintext =
            serde_json::to_vec(&payload).map_err(|e| format!("Failed to encode MLS state: {e}"))?;
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|_| "Failed to initialize MLS state cipher".to_string())?;
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &plaintext,
                    aad: &state_aad(&self.scope),
                },
            )
            .map_err(|_| "Failed to encrypt MLS state".to_string())?;
        let snapshot = EncryptedSnapshot {
            version: SNAPSHOT_VERSION,
            nonce: URL_SAFE_NO_PAD.encode(nonce),
            ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
        };
        let encoded = serde_json::to_vec(&snapshot)
            .map_err(|e| format!("Failed to encode encrypted MLS state: {e}"))?;
        write_atomic(&self.path, &encoded)
    }

    fn read_snapshot(
        path: &Path,
        key: &[u8],
        scope: &str,
        identity: &str,
    ) -> Result<SnapshotPayload, String> {
        let metadata =
            fs::metadata(path).map_err(|e| format!("Failed to inspect MLS state: {e}"))?;
        if metadata.len() > MAX_STATE_BYTES {
            return Err("MLS state exceeds the 256 MiB safety limit".to_string());
        }
        let encoded = fs::read(path).map_err(|e| format!("Failed to read MLS state: {e}"))?;
        let snapshot: EncryptedSnapshot = serde_json::from_slice(&encoded)
            .map_err(|_| "MLS state file is invalid or not encrypted".to_string())?;
        if snapshot.version != SNAPSHOT_VERSION {
            return Err(format!(
                "Unsupported MLS state version: {}",
                snapshot.version
            ));
        }
        let nonce = URL_SAFE_NO_PAD
            .decode(snapshot.nonce)
            .map_err(|_| "MLS state nonce is invalid".to_string())?;
        if nonce.len() != 12 {
            return Err("MLS state nonce has the wrong length".to_string());
        }
        let ciphertext = URL_SAFE_NO_PAD
            .decode(snapshot.ciphertext)
            .map_err(|_| "MLS state ciphertext is invalid".to_string())?;
        let cipher = Aes256Gcm::new_from_slice(key)
            .map_err(|_| "Failed to initialize MLS state cipher".to_string())?;
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &state_aad(scope),
                },
            )
            .map_err(|_| {
                "MLS state authentication failed; key, account scope, or file contents do not match"
                    .to_string()
            })?;
        let payload: SnapshotPayload = serde_json::from_slice(&plaintext)
            .map_err(|_| "Decrypted MLS state is invalid".to_string())?;
        if payload.version != SNAPSHOT_VERSION
            || payload.scope != scope
            || payload.identity != identity
        {
            return Err("MLS state belongs to another account or device".to_string());
        }
        Ok(payload)
    }

    fn credential(&self) -> CredentialWithKey {
        let scope_hash = URL_SAFE_NO_PAD.encode(Sha256::digest(self.scope.as_bytes()));
        let credential =
            BasicCredential::new(format!("otto:v1:{scope_hash}:{}", self.identity).into_bytes());
        CredentialWithKey {
            credential: credential.into(),
            signature_key: self.signer.to_public_vec().into(),
        }
    }

    fn load_group(&self, conversation_id: &str) -> Result<MlsGroup, String> {
        MlsGroup::load(self.provider.storage(), &self.group_id(conversation_id))
            .map_err(|e| format!("Failed to load MLS group: {e}"))?
            .ok_or_else(|| "MLS group is not initialized for this conversation".to_string())
    }

    fn group_id(&self, conversation_id: &str) -> GroupId {
        let mut digest = Sha256::new();
        digest.update(GROUP_ID_LABEL);
        digest.update((self.scope.len() as u64).to_be_bytes());
        digest.update(self.scope.as_bytes());
        digest.update((conversation_id.len() as u64).to_be_bytes());
        digest.update(conversation_id.as_bytes());
        GroupId::from_slice(&digest.finalize())
    }

    fn control_aad(&self, conversation_id: &str) -> Vec<u8> {
        bound_aad(
            CONTROL_AAD_LABEL,
            &self.scope,
            conversation_id,
            "membership",
        )
    }

    fn message_aad(&self, conversation_id: &str, aad: &str) -> Vec<u8> {
        bound_aad(MESSAGE_AAD_LABEL, &self.scope, conversation_id, aad)
    }
}

fn ciphersuite() -> Ciphersuite {
    Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519
}

fn ciphersuite_name() -> &'static str {
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"
}

fn group_result(conversation_id: &str, group: &MlsGroup) -> GroupResult {
    GroupResult {
        conversation_id: conversation_id.to_string(),
        epoch: group.epoch().as_u64(),
        member_count: group.members().count(),
    }
}

fn validate_text(name: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{name} must not be empty"));
    }
    if value.as_bytes().len() > MAX_TEXT_FIELD_BYTES {
        return Err(format!("{name} exceeds 8 KiB"));
    }
    Ok(())
}

fn validate_aad(value: &str) -> Result<(), String> {
    if value.as_bytes().len() > MAX_TEXT_FIELD_BYTES {
        return Err("aad exceeds 8 KiB".to_string());
    }
    Ok(())
}

fn decode_wire(name: &str, value: &str) -> Result<Vec<u8>, String> {
    if value.len() > MAX_PLAINTEXT_BYTES * 2 {
        return Err(format!("MLS {name} exceeds the safety limit"));
    }
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| format!("MLS {name} is not valid base64url"))
}

fn state_aad(scope: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(STATE_AAD_LABEL.len() + 8 + scope.len());
    aad.extend_from_slice(STATE_AAD_LABEL);
    aad.extend_from_slice(&(scope.len() as u64).to_be_bytes());
    aad.extend_from_slice(scope.as_bytes());
    aad
}

fn bound_aad(label: &[u8], scope: &str, conversation_id: &str, external: &str) -> Vec<u8> {
    let mut aad =
        Vec::with_capacity(label.len() + scope.len() + conversation_id.len() + external.len() + 24);
    for part in [
        scope.as_bytes(),
        conversation_id.as_bytes(),
        external.as_bytes(),
    ] {
        aad.extend_from_slice(&(part.len() as u64).to_be_bytes());
        aad.extend_from_slice(part);
    }
    aad.splice(0..0, label.iter().copied());
    aad
}

fn deserialize_connection(bytes: Vec<u8>) -> Result<Connection, String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_STATE_BYTES {
        return Err("MLS SQLite state has an invalid size".to_string());
    }
    let size = bytes.len();
    let raw = unsafe { rusqlite::ffi::sqlite3_malloc64(size as u64) } as *mut u8;
    let pointer =
        NonNull::new(raw).ok_or_else(|| "Unable to allocate memory for MLS state".to_string())?;
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer.as_ptr(), size);
    }
    let data = unsafe { OwnedData::from_raw_nonnull(pointer, size) };
    let mut connection = Connection::open_in_memory()
        .map_err(|e| format!("Failed to open MLS memory store: {e}"))?;
    connection
        .deserialize(DatabaseName::Main, data, false)
        .map_err(|e| format!("Failed to restore MLS memory store: {e}"))?;
    Ok(connection)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create MLS state directory: {e}"))?;
    let mut temporary = NamedTempFile::new_in(parent)
        .map_err(|e| format!("Failed to create temporary MLS state: {e}"))?;
    temporary
        .write_all(bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|e| format!("Failed to write MLS state: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Failed to protect MLS state permissions: {e}"))?;
    }

    temporary
        .persist(path)
        .map_err(|e| format!("Failed to replace MLS state atomically: {}", e.error))?;
    Ok(())
}
