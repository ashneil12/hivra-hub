import { useState } from "react";
import { setUserName, storedUserName } from "../model/userName";

/** What the team calls the user (userName.ts): the same setting onboarding asks for. Empty: agents say "the user". */
export function UserNameField() {
  const [name, setName] = useState(storedUserName);
  return (
    <label className="flex h-7 w-52 max-w-full shrink-0 items-center rounded-md border border-content/10 px-2 focus-within:border-content/20">
      <input
        data-user-name
        value={name}
        maxLength={40}
        onChange={(event) => {
          setName(event.target.value);
          setUserName(event.target.value);
        }}
        placeholder="Your name"
        aria-label="What should your team call you?"
        autoComplete="off"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35"
      />
    </label>
  );
}
