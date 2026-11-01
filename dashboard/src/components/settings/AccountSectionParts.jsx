import React from "react";
import { Pencil } from "lucide-react";
import { useLoginModal } from "../../contexts/LoginModalContext.jsx";
import { copy } from "../../lib/copy";
import { SectionCard, SETTINGS_INPUT_CLASS, ToggleSwitch } from "./Controls.jsx";
import { Button } from "../../ui/components/Button.jsx";

function InlineEditorActions({ disabled, onCancel, onSave, saveLabel = copy("settings.account.save") }) {
  return (
    <>
      <Button
        variant="primary"
        size="sm"
        onClick={onSave}
        disabled={disabled}
      >
        {saveLabel}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onCancel}
        className="text-oai-gray-500 hover:text-oai-gray-700 dark:hover:text-oai-gray-300"
      >
        {copy("settings.account.cancel")}
      </Button>
    </>
  );
}

function EditNameControls({ nameInput, setEditingName, setNameInput, profileSaving, handleSaveName }) {
  return (
    <div className="mt-2 flex items-center gap-2">
      <input
        type="text"
        value={nameInput}
        onChange={(e) => setNameInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSaveName();
          if (e.key === "Escape") setEditingName(false);
        }}
        maxLength={50}
        autoFocus
        className={`flex-1 ${SETTINGS_INPUT_CLASS}`}
        placeholder={copy("settings.account.displayName")}
      />
      <InlineEditorActions
        disabled={profileSaving || !nameInput.trim()}
        onCancel={() => setEditingName(false)}
        onSave={handleSaveName}
        saveLabel={profileSaving ? copy("settings.account.saving") : undefined}
      />
    </div>
  );
}

function EditGithubControls({
  githubError,
  githubInput,
  handleSaveGithub,
  profileSaving,
  setEditingGithub,
  setGithubError,
  setGithubInput,
}) {
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={githubInput}
          onChange={(event) => {
            setGithubInput(event.target.value);
            if (githubError) setGithubError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") handleSaveGithub();
            if (event.key === "Escape") {
              setEditingGithub(false);
              setGithubError(null);
            }
          }}
          maxLength={100}
          autoFocus
          className={`flex-1 ${SETTINGS_INPUT_CLASS}`}
          placeholder={copy("settings.account.githubUrlPlaceholder")}
        />
        <InlineEditorActions
          disabled={profileSaving}
          onCancel={() => {
            setEditingGithub(false);
            setGithubError(null);
          }}
          onSave={handleSaveGithub}
          saveLabel={profileSaving ? copy("settings.account.saving") : undefined}
        />
      </div>
      {githubError ? (
        <div className="mt-1.5 text-xs text-red-600 dark:text-red-400">{githubError}</div>
      ) : null}
    </div>
  );
}

function EditButton({ disabled = false, label, onClick, title }) {
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="gap-1.5"
    >
      <Pencil className="h-3.5 w-3.5" aria-hidden />
      <span>{label}</span>
    </Button>
  );
}

function SettingsField({ actions, editing, editor, hint, label }) {
  return (
    <div className="py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-oai-gray-900 dark:text-oai-gray-200">{label}</div>
          {editing ? editor : (
            <div className="mt-0.5 truncate text-xs text-oai-gray-500 dark:text-oai-gray-400">
              {hint}
            </div>
          )}
        </div>
        {editing ? null : actions}
      </div>
    </div>
  );
}

function DisplayNameActions({ name }) {
  const title = name.anonymousOn
    ? copy("settings.account.displayNameDisabledWhileAnon")
    : undefined;

  return (
    <div className="flex shrink-0 items-center gap-2">
      <EditButton
        disabled={name.anonymousOn}
        label={copy("settings.account.edit")}
        onClick={name.startEditingName}
        title={title}
      />
      <ToggleSwitch
        checked={!name.anonymousOn}
        onChange={name.handleAnonymousToggle}
        disabled={name.profileLoading || name.profileSaving}
        ariaLabel={copy("settings.account.displayName")}
      />
    </div>
  );
}

function DisplayNameField({ name }) {
  const {
    anonymousOn,
    customDisplayName,
    displayName,
    editingName,
    handleAnonymousToggle,
    handleSaveName,
    nameInput,
    profileLoading,
    profileSaving,
    setEditingName,
    setNameInput,
    startEditingName,
  } = name;

  const displayValue = anonymousOn
    ? copy("settings.account.displayNameAnonymousHint")
    : (customDisplayName || displayName);

  return (
    <SettingsField
      label={copy("settings.account.displayName")}
      editing={editingName}
      hint={displayValue}
      editor={
        <EditNameControls
          nameInput={nameInput}
          setEditingName={setEditingName}
          setNameInput={setNameInput}
          profileSaving={profileSaving}
          handleSaveName={handleSaveName}
        />
      }
      actions={<DisplayNameActions name={name} />}
    />
  );
}

function GithubProfileField({ github }) {
  const {
    editingGithub,
    githubError,
    githubInput,
    githubUrl,
    handleSaveGithub,
    handleShowGithubToggle,
    profileLoading,
    profileSaving,
    setEditingGithub,
    setGithubError,
    setGithubInput,
    showGithubOn,
    startEditingGithub,
  } = github;

  return (
    <>
      <SettingsField
        label={copy("settings.account.githubUrl")}
        editing={editingGithub}
        hint={githubUrl || copy("settings.account.githubUrlHint")}
        editor={
          <EditGithubControls
            githubError={githubError}
            githubInput={githubInput}
            handleSaveGithub={handleSaveGithub}
            profileSaving={profileSaving}
            setEditingGithub={setEditingGithub}
            setGithubError={setGithubError}
            setGithubInput={setGithubInput}
          />
        }
        actions={
          <div className="flex shrink-0 items-center gap-2">
            <EditButton label={copy("settings.account.edit")} onClick={startEditingGithub} />
            <ToggleSwitch
              checked={showGithubOn}
              onChange={handleShowGithubToggle}
              disabled={profileLoading || profileSaving}
              ariaLabel={copy("settings.account.githubUrl")}
            />
          </div>
        }
      />
    </>
  );
}

export function SignedOutAccountSection() {
  const { openLoginModal } = useLoginModal();
  return (
    <SectionCard title={copy("settings.section.account")}>
      <div className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
          {copy("settings.account.signedOutHint")}
        </p>
        <Button
          variant="primary"
          size="sm"
          onClick={openLoginModal}
        >
          {copy("settings.account.signIn")}
        </Button>
      </div>
    </SectionCard>
  );
}

export function PublicProfileFields({ name, github }) {
  return (
    <>
      <DisplayNameField name={name} />
      <GithubProfileField github={github} />
    </>
  );
}
