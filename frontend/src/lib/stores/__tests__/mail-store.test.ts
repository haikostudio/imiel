import { describe, it, expect, beforeEach } from "vitest";
import { useMailStore } from "../mail-store";

describe("mail-store", () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset store entre chaque test
    useMailStore.setState({
      activeAccountId: null,
      activeFolderIds: [],
      activeFolder: "inbox",
      selectedMessageId: null,
      selectedThreadId: null,
      searchQuery: "",
      searchOpen: false,
      composeInstances: [],
      focusedComposeId: null,
      sidebarCollapsed: false,
    });
  });

  describe("etat initial", () => {
    it("a les valeurs par defaut correctes", () => {
      const state = useMailStore.getState();
      expect(state.activeAccountId).toBeNull();
      expect(state.activeFolderIds).toEqual([]);
      expect(state.activeFolder).toBe("inbox");
      expect(state.selectedMessageId).toBeNull();
      expect(state.selectedThreadId).toBeNull();
      expect(state.searchQuery).toBe("");
      expect(state.searchOpen).toBe(false);
      expect(state.composeInstances).toEqual([]);
      expect(state.sidebarCollapsed).toBe(false);
    });
  });

  describe("setActiveAccount", () => {
    it("met a jour le compte actif", () => {
      useMailStore.getState().setActiveAccount("acc1");
      expect(useMailStore.getState().activeAccountId).toBe("acc1");
    });

    it("reset la selection de message", () => {
      useMailStore.setState({
        selectedMessageId: "msg1",
        selectedThreadId: "t1",
      });
      useMailStore.getState().setActiveAccount("acc2");
      expect(useMailStore.getState().selectedMessageId).toBeNull();
      expect(useMailStore.getState().selectedThreadId).toBeNull();
    });

    it("accepte 'all' comme valeur", () => {
      useMailStore.getState().setActiveAccount("all");
      expect(useMailStore.getState().activeAccountId).toBe("all");
    });

    it("accepte null", () => {
      useMailStore.getState().setActiveAccount("acc1");
      useMailStore.getState().setActiveAccount(null);
      expect(useMailStore.getState().activeAccountId).toBeNull();
    });
  });

  describe("setActiveFolder", () => {
    it("met a jour le dossier actif", () => {
      useMailStore.getState().setActiveFolder(["folder1"], "sent");
      const state = useMailStore.getState();
      expect(state.activeFolderIds).toEqual(["folder1"]);
      expect(state.activeFolder).toBe("sent");
    });

    it("reset la selection de message", () => {
      useMailStore.setState({ selectedMessageId: "msg1" });
      useMailStore.getState().setActiveFolder(["folder2"]);
      expect(useMailStore.getState().selectedMessageId).toBeNull();
    });

    it("garde le folderType courant si non specifie", () => {
      useMailStore.setState({ activeFolder: "drafts" });
      useMailStore.getState().setActiveFolder(["folder2"]);
      expect(useMailStore.getState().activeFolder).toBe("drafts");
    });
  });

  describe("selectMessage", () => {
    it("selectionne un message", () => {
      useMailStore.getState().selectMessage("msg1", "t1");
      const state = useMailStore.getState();
      expect(state.selectedMessageId).toBe("msg1");
      expect(state.selectedThreadId).toBe("t1");
    });

    it("deselectionne avec null", () => {
      useMailStore.getState().selectMessage("msg1", "t1");
      useMailStore.getState().selectMessage(null);
      const state = useMailStore.getState();
      expect(state.selectedMessageId).toBeNull();
      expect(state.selectedThreadId).toBeNull();
    });
  });

  describe("openCompose / closeCompose", () => {
    it("ouvre en mode nouveau par defaut", () => {
      useMailStore.getState().openCompose();
      const state = useMailStore.getState();
      expect(state.composeInstances).toHaveLength(1);
      expect(state.composeInstances[0].mode).toBe("new");
      expect(state.composeInstances[0].replyToMessageId).toBeNull();
    });

    it("ouvre en mode reply avec messageId", () => {
      useMailStore.getState().openCompose("reply", "msg1");
      const state = useMailStore.getState();
      expect(state.composeInstances).toHaveLength(1);
      expect(state.composeInstances[0].mode).toBe("reply");
      expect(state.composeInstances[0].replyToMessageId).toBe("msg1");
    });

    it("ouvre en mode reply-all", () => {
      useMailStore.getState().openCompose("reply-all", "msg2");
      expect(useMailStore.getState().composeInstances[0].mode).toBe("reply-all");
    });

    it("ouvre en mode forward", () => {
      useMailStore.getState().openCompose("forward", "msg3");
      expect(useMailStore.getState().composeInstances[0].mode).toBe("forward");
    });

    it("ferme la derniere instance", () => {
      useMailStore.getState().openCompose("reply", "msg1");
      useMailStore.getState().closeCompose();
      const state = useMailStore.getState();
      expect(state.composeInstances).toHaveLength(0);
    });

    it("ouvre plusieurs instances", () => {
      useMailStore.getState().openCompose("new");
      useMailStore.getState().openCompose("edit", "draft1");
      expect(useMailStore.getState().composeInstances).toHaveLength(2);
    });

    it("ne duplique pas un brouillon deja ouvert", () => {
      useMailStore.getState().openCompose("edit", "draft1");
      useMailStore.getState().openCompose("edit", "draft1");
      expect(useMailStore.getState().composeInstances).toHaveLength(1);
    });

    it("ne duplique pas une fenetre 'nouveau message' encore vide", () => {
      useMailStore.getState().openCompose("new");
      useMailStore.getState().openCompose("new");
      useMailStore.getState().openCompose("new");
      expect(useMailStore.getState().composeInstances).toHaveLength(1);
    });

    it("autorise une nouvelle fenetre une fois la precedente remplie", () => {
      useMailStore.getState().openCompose("new");
      const firstId = useMailStore.getState().composeInstances[0].id;
      // La fenetre recoit du contenu -> un nouveau clic ouvre bien une 2e fenetre
      useMailStore.getState().setComposeHasContent(firstId, true);
      useMailStore.getState().openCompose("new");
      expect(useMailStore.getState().composeInstances).toHaveLength(2);
    });

    it("distingue les fenetres 'nouveau message' par destinataire initial", () => {
      useMailStore.getState().openCompose("new", null, "a@b.com");
      useMailStore.getState().openCompose("new", null, "c@d.com");
      expect(useMailStore.getState().composeInstances).toHaveLength(2);
      // Meme destinataire encore vide : pas de doublon
      useMailStore.getState().openCompose("new", null, "a@b.com");
      expect(useMailStore.getState().composeInstances).toHaveLength(2);
    });

    it("refocalise la fenetre vide existante au lieu d'en creer une", () => {
      useMailStore.getState().openCompose("new");
      const firstId = useMailStore.getState().composeInstances[0].id;
      useMailStore.getState().openCompose("reply", "msg1");
      // Une fenetre vide 'new' existe deja : la rouvrir la refocalise
      useMailStore.getState().openCompose("new");
      expect(useMailStore.getState().composeInstances).toHaveLength(2);
      expect(useMailStore.getState().focusedComposeId).toBe(firstId);
    });

    it("ferme une instance specifique par id", () => {
      useMailStore.getState().openCompose("new");
      useMailStore.getState().openCompose("edit", "draft1");
      const id = useMailStore.getState().composeInstances[0].id;
      useMailStore.getState().closeCompose(id);
      expect(useMailStore.getState().composeInstances).toHaveLength(1);
      expect(useMailStore.getState().composeInstances[0].mode).toBe("edit");
    });
  });

  describe("toggleSidebar", () => {
    it("toggle l'etat de la sidebar", () => {
      expect(useMailStore.getState().sidebarCollapsed).toBe(false);
      useMailStore.getState().toggleSidebar();
      expect(useMailStore.getState().sidebarCollapsed).toBe(true);
      useMailStore.getState().toggleSidebar();
      expect(useMailStore.getState().sidebarCollapsed).toBe(false);
    });
  });

  describe("search", () => {
    it("ouvre la recherche", () => {
      useMailStore.getState().openSearch();
      expect(useMailStore.getState().searchOpen).toBe(true);
    });

    it("ferme la recherche et reset la query", () => {
      useMailStore.setState({ searchOpen: true, searchQuery: "test" });
      useMailStore.getState().closeSearch();
      const state = useMailStore.getState();
      expect(state.searchOpen).toBe(false);
      expect(state.searchQuery).toBe("");
    });

    it("met a jour la query de recherche", () => {
      useMailStore.getState().setSearchQuery("hello world");
      expect(useMailStore.getState().searchQuery).toBe("hello world");
    });
  });
});
