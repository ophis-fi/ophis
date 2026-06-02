import IMAGE_APPDATA from 'assets/img/code.svg'
import IMAGE_DOC from 'assets/img/doc.svg'
import IMAGE_OPHIS from 'assets/img/ophis-logo.svg'
import { FaGithub, FaXTwitter } from 'react-icons/fa6'
import { PiMathOperationsFill } from 'react-icons/pi'

import { MenuItemKind, MenuLink, MenuTreeItem } from './types'

import { DOCS_LINK, PROTOCOL_LINK, COWSWAP_LINK, TWITTER_LINK, Routes } from '../../../explorer/const'

// Ophis has no Discord/Dune; the real community surfaces are X + the Ophis GitHub org.
const GITHUB_ORG_LINK = 'https://github.com/ophis-fi'

export function getMainMenu(isSolversEnabled = true): MenuTreeItem[] {
  const otherLinks: MenuLink[] = [
    ...(isSolversEnabled
      ? [
          {
            title: 'Solvers',
            url: Routes.SOLVERS,
            iconComponent: PiMathOperationsFill,
            noPrefix: true,
          } satisfies MenuLink,
        ]
      : []),
    {
      title: 'AppData',
      url: Routes.APPDATA,
      iconSVG: IMAGE_APPDATA,
    },
  ]

  return [
    {
      title: 'Home',
      url: Routes.HOME,
    },
    {
      kind: MenuItemKind.DROP_DOWN,
      title: 'More',
      items: [
        {
          sectionTitle: 'OVERVIEW',
          links: [
            {
              title: 'Ophis Swap',
              url: COWSWAP_LINK,
              kind: MenuItemKind.EXTERNAL_LINK,
              iconSVG: IMAGE_OPHIS,
            },
            {
              title: 'Ophis',
              url: PROTOCOL_LINK,
              kind: MenuItemKind.EXTERNAL_LINK,
              iconSVG: IMAGE_OPHIS,
            },
            {
              title: 'Documentation',
              url: DOCS_LINK,
              kind: MenuItemKind.EXTERNAL_LINK,
              iconSVG: IMAGE_DOC,
            },
          ],
        },
        {
          sectionTitle: 'COMMUNITY',
          links: [
            {
              title: 'X',
              url: TWITTER_LINK,
              kind: MenuItemKind.EXTERNAL_LINK,
              iconComponent: FaXTwitter,
            },
            {
              title: 'GitHub',
              url: GITHUB_ORG_LINK,
              kind: MenuItemKind.EXTERNAL_LINK,
              iconComponent: FaGithub,
            },
          ],
        },
        {
          sectionTitle: 'OTHER',
          links: otherLinks,
        },
      ],
    },
  ]
}

export const MAIN_MENU = getMainMenu()
