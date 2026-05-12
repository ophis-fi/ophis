import { InputHTMLAttributes, ReactNode } from 'react'

import { Search } from 'react-feather'
import styled from 'styled-components/macro'

import { UI } from '../../enum'

const Wrapper = styled.div`
  display: inline-flex;
  align-items: center;
  flex-direction: row;
  width: 100%;
`

const SearchIcon = styled(Search)`
  color: var(${UI.COLOR_TEXT_OPACITY_70});
`

const SearchInputEl = styled.input`
  // Ophis/Nucleus: token-driven padding + radius, Plus Jakarta inheritance.
  position: relative;
  display: flex;
  padding: var(--ophis-space-2, 8px) var(--ophis-space-4, 16px);
  align-items: center;
  width: 100%;
  white-space: nowrap;
  outline: none;
  background: transparent;
  color: inherit;
  appearance: none;
  font-family: var(--ophis-font-body);
  font-size: 16px;
  border-radius: var(--ophis-radius-md, 8px);
  border: none;

  &::placeholder {
    color: inherit;
    opacity: 0.7;
    transition: color var(${UI.ANIMATION_DURATION}) ease-in-out;
  }

  &:focus::placeholder {
    color: transparent;
  }
`

export function SearchInput(props: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return (
    <Wrapper>
      <SearchIcon size={20} />
      <SearchInputEl type="text" {...props} />
    </Wrapper>
  )
}
